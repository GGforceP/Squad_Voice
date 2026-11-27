package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	maxImage     = 5 * 1024 * 1024
	defaultCache = 10 * 1024 * 1024 * 1024
	eventWindow  = 4096
)

var (
	forumBucket   = []byte("channels")
	indexBucket   = []byte("messages")
	mediaBucket   = []byte("images")
	nonceBucket   = []byte("nonces")
	eventBucket   = []byte("events")
	metaBucket    = []byte("metadata")
	epochKey      = []byte("epoch")
	bytesKey      = []byte("imageBytes")
	errImageQuota = errors.New("image exceeds storage quota")
)

type chatMessage struct {
	ID        uint64    `json:"id"`
	Channel   string    `json:"channelId"`
	Author    string    `json:"author"`
	AuthorID  string    `json:"authorId"`
	Text      string    `json:"text"`
	Time      time.Time `json:"time"`
	Image     string    `json:"image,omitempty"`
	ImageSize int       `json:"imageSize,omitempty"`
	ImageGone bool      `json:"imageGone,omitempty"`
	Nonce     string    `json:"nonce,omitempty"`
}

type chatEvent struct {
	Op      string `json:"op"`
	Channel string `json:"channelId"`
	ID      uint64 `json:"id,omitempty"`
}

type chatUpdates struct {
	Epoch  string      `json:"epoch"`
	Cursor uint64      `json:"cursor"`
	Reset  bool        `json:"reset"`
	Events []chatEvent `json:"events"`
}

type chatPage struct {
	Tag       string        `json:"tag"`
	Unchanged bool          `json:"unchanged"`
	More      bool          `json:"more"`
	Messages  []chatMessage `json:"messages"`
}

type chatStore struct {
	db      *bolt.DB
	images  string
	quota   uint64
	epoch   string
	mu      sync.Mutex // Keeps file publication and deletion ordered with metadata transactions.
	eventMu sync.Mutex
	changed chan struct{}
}

func cacheQuota(value string) (uint64, error) {
	if strings.TrimSpace(value) == "" {
		return defaultCache, nil
	}
	mb, err := strconv.ParseUint(strings.TrimSpace(value), 10, 43)
	if err != nil {
		return 0, errors.New("cachesize must be a nonnegative integer in MB")
	}
	return mb * 1024 * 1024, nil
}

func openChat(dir string, quota uint64, workspace state) (*chatStore, error) {
	c := &chatStore{images: filepath.Join(dir, "images"), quota: quota, changed: make(chan struct{})}
	if err := os.MkdirAll(c.images, 0700); err != nil {
		return nil, err
	}
	var err error
	c.db, err = bolt.Open(filepath.Join(dir, "chat.db"), 0600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, err
	}
	err = c.db.Update(func(tx *bolt.Tx) error {
		for _, key := range [][]byte{forumBucket, indexBucket, mediaBucket, nonceBucket, eventBucket, metaBucket} {
			if _, err := tx.CreateBucketIfNotExists(key); err != nil {
				return err
			}
		}
		meta := tx.Bucket(metaBucket)
		c.epoch = string(meta.Get(epochKey))
		if c.epoch == "" {
			c.epoch = randomToken(18)
			return meta.Put(epochKey, []byte(c.epoch))
		}
		return nil
	})
	if err == nil {
		err = c.reconcile(workspace)
	}
	if err != nil {
		c.db.Close()
		return nil, err
	}
	return c, nil
}

func (c *chatStore) close() { _ = c.db.Close() }

func seqKey(n uint64) []byte { return binary.BigEndian.AppendUint64(nil, n) }

func seqValue(key []byte) uint64 {
	if len(key) != 8 {
		return 0
	}
	return binary.BigEndian.Uint64(key)
}

func putJSON(bucket *bolt.Bucket, key []byte, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return bucket.Put(key, body)
}

func recordChatEvent(tx *bolt.Tx, event chatEvent) error {
	events := tx.Bucket(eventBucket)
	seq, err := events.NextSequence()
	if err != nil {
		return err
	}
	if seq > eventWindow {
		if err := events.Delete(seqKey(seq - eventWindow)); err != nil {
			return err
		}
	}
	return putJSON(events, seqKey(seq), event)
}

func (c *chatStore) eventSignal() <-chan struct{} {
	c.eventMu.Lock()
	defer c.eventMu.Unlock()
	return c.changed
}

func (c *chatStore) notify() {
	c.eventMu.Lock()
	defer c.eventMu.Unlock()
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *chatStore) updates(epoch string, after uint64) (chatUpdates, error) {
	out := chatUpdates{Epoch: c.epoch, Events: []chatEvent{}}
	err := c.db.View(func(tx *bolt.Tx) error {
		events := tx.Bucket(eventBucket)
		out.Cursor = events.Sequence()
		if epoch != c.epoch || after > out.Cursor || out.Cursor-after > eventWindow {
			out.Reset = true
			return nil
		}
		cursor := events.Cursor()
		for k, v := cursor.Seek(seqKey(after + 1)); k != nil; k, v = cursor.Next() {
			var event chatEvent
			if err := json.Unmarshal(v, &event); err != nil {
				return err
			}
			out.Events = append(out.Events, event)
			// Keep each authenticated reply small, even after a long absence.
			if len(out.Events) == 256 {
				out.Cursor = seqValue(k)
				break
			}
		}
		return nil
	})
	return out, err
}

func (c *chatStore) page(channel string, before, after uint64, limit int, known string) (chatPage, error) {
	out := chatPage{Messages: []chatMessage{}}
	err := c.db.View(func(tx *bolt.Tx) error {
		room := tx.Bucket(forumBucket).Bucket([]byte(channel))
		if room == nil {
			return nil
		}
		cur := room.Cursor()
		var key, data []byte
		step := cur.Prev
		if after != 0 {
			key, data = cur.Seek(seqKey(after + 1))
			step = cur.Next
		} else if before == 0 {
			key, data = cur.Last()
		} else if key, _ = cur.Seek(seqKey(before)); key == nil {
			key, data = cur.Last()
		} else {
			key, data = cur.Prev()
		}
		for key != nil && len(out.Messages) < limit {
			var item chatMessage
			if err := json.Unmarshal(data, &item); err != nil {
				return err
			}
			item.Nonce = ""
			out.Messages = append(out.Messages, item)
			key, data = step()
		}
		out.More = key != nil
		if after == 0 {
			slices.Reverse(out.Messages)
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	body, err := json.Marshal(out)
	if err != nil {
		return out, err
	}
	checksum := sha256.Sum256(body)
	out.Tag = hex.EncodeToString(checksum[:])
	if known == out.Tag {
		out.Unchanged = true
		out.Messages = nil
	}
	return out, nil
}

func chatItem(tx *bolt.Tx, id uint64) (*bolt.Bucket, chatMessage, error) {
	var item chatMessage
	seq := seqKey(id)
	roomID := tx.Bucket(indexBucket).Get(seq)
	if roomID == nil {
		return nil, item, errMissing
	}
	room := tx.Bucket(forumBucket).Bucket(roomID)
	if room == nil {
		return nil, item, errors.New("chat channel index is inconsistent")
	}
	return room, item, json.Unmarshal(room.Get(seq), &item)
}

func (c *chatStore) imagePath(id uint64) string {
	return filepath.Join(c.images, strconv.FormatUint(id, 10)+".blob")
}

func (c *chatStore) append(item chatMessage, image []byte) (chatMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if uint64(len(image)) > c.quota {
		return chatMessage{}, errImageQuota
	}
	removed := []uint64{}
	var published uint64
	created := false
	err := c.db.Update(func(tx *bolt.Tx) error {
		nonces := tx.Bucket(nonceBucket)
		replay := []byte(item.AuthorID + "/" + item.Nonce)
		if id := seqValue(nonces.Get(replay)); id != 0 {
			_, previous, err := chatItem(tx, id)
			if err != nil {
				return err
			}
			if previous.Channel != item.Channel {
				return errors.New("message was already sent to another channel")
			}
			item = previous
			return nil
		}
		index := tx.Bucket(indexBucket)
		id, err := index.NextSequence()
		if err != nil {
			return err
		}
		item.ID = id
		key := seqKey(id)
		room, err := tx.Bucket(forumBucket).CreateBucketIfNotExists([]byte(item.Channel))
		if err != nil {
			return err
		}
		if len(image) != 0 {
			published = id
			if err := publishImage(c.imagePath(id), image); err != nil {
				return err
			}
			media := tx.Bucket(mediaBucket)
			if err := media.Put(key, seqKey(uint64(len(image)))); err != nil {
				return err
			}
			meta := tx.Bucket(metaBucket)
			if err := meta.Put(bytesKey, seqKey(seqValue(meta.Get(bytesKey))+uint64(len(image)))); err != nil {
				return err
			}
		}
		if err := putJSON(room, key, item); err != nil {
			return err
		}
		if err := index.Put(key, []byte(item.Channel)); err != nil {
			return err
		}
		if err := nonces.Put(replay, key); err != nil {
			return err
		}
		if err := recordChatEvent(tx, chatEvent{Op: "message", Channel: item.Channel, ID: id}); err != nil {
			return err
		}
		created = true
		return c.prune(tx, &removed)
	})
	if err != nil {
		if published != 0 {
			_ = os.Remove(c.imagePath(published))
		}
		return chatMessage{}, err
	}
	if created {
		c.finish(removed)
	}
	item.Nonce = ""
	return item, nil
}

func publishImage(path string, body []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(body); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	// Linux needs the parent directory synced before the database commits.
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func removeImage(tx *bolt.Tx, id uint64, removed *[]uint64) error {
	images, meta := tx.Bucket(mediaBucket), tx.Bucket(metaBucket)
	key := seqKey(id)
	size := seqValue(images.Get(key))
	if size == 0 {
		return nil
	}
	if err := images.Delete(key); err != nil {
		return err
	}
	if err := meta.Put(bytesKey, seqKey(seqValue(meta.Get(bytesKey))-size)); err != nil {
		return err
	}
	*removed = append(*removed, id)
	return nil
}

func expireImage(tx *bolt.Tx, id uint64, removed *[]uint64) error {
	room, item, err := chatItem(tx, id)
	if err != nil {
		return err
	}
	item.Image, item.ImageSize, item.ImageGone = "", 0, true
	if err := putJSON(room, seqKey(id), item); err != nil {
		return err
	}
	if err := removeImage(tx, id, removed); err != nil {
		return err
	}
	return recordChatEvent(tx, chatEvent{Op: "image", Channel: item.Channel, ID: id})
}

func (c *chatStore) prune(tx *bolt.Tx, removed *[]uint64) error {
	for seqValue(tx.Bucket(metaBucket).Get(bytesKey)) > c.quota {
		key, _ := tx.Bucket(mediaBucket).Cursor().First()
		if key == nil {
			return errors.New("chat image quota index is inconsistent")
		}
		if err := expireImage(tx, seqValue(key), removed); err != nil {
			return err
		}
	}
	return nil
}

func removeChatItem(tx *bolt.Tx, id uint64, removed *[]uint64) (chatMessage, error) {
	room, item, err := chatItem(tx, id)
	if err != nil {
		return item, err
	}
	if err := removeImage(tx, id, removed); err != nil {
		return item, err
	}
	seq := seqKey(id)
	if err := tx.Bucket(nonceBucket).Delete([]byte(item.AuthorID + "/" + item.Nonce)); err != nil {
		return item, err
	}
	if err := room.Delete(seq); err != nil {
		return item, err
	}
	return item, tx.Bucket(indexBucket).Delete(seq)
}

func (c *chatStore) deleteMessage(channel string, id uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := []uint64{}
	err := c.db.Update(func(tx *bolt.Tx) error {
		if !bytes.Equal(tx.Bucket(indexBucket).Get(seqKey(id)), []byte(channel)) {
			return errMissing
		}
		if _, err := removeChatItem(tx, id, &removed); err != nil {
			return err
		}
		return recordChatEvent(tx, chatEvent{Op: "delete", Channel: channel, ID: id})
	})
	if err == nil {
		c.finish(removed)
	}
	return err
}

func dropChatChannel(tx *bolt.Tx, channel string, removed *[]uint64) error {
	forum := tx.Bucket(forumBucket)
	room := forum.Bucket([]byte(channel))
	if room != nil {
		for {
			key, _ := room.Cursor().First()
			if key == nil {
				break
			}
			if _, err := removeChatItem(tx, seqValue(key), removed); err != nil {
				return err
			}
		}
		if err := forum.DeleteBucket([]byte(channel)); err != nil {
			return err
		}
	}
	return recordChatEvent(tx, chatEvent{Op: "channel", Channel: channel})
}

func (c *chatStore) deleteChannel(channel string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := []uint64{}
	err := c.db.Update(func(tx *bolt.Tx) error { return dropChatChannel(tx, channel, &removed) })
	if err == nil {
		c.finish(removed)
	}
	return err
}

func (c *chatStore) finish(removed []uint64) {
	for _, id := range removed {
		if err := os.Remove(c.imagePath(id)); err != nil && !os.IsNotExist(err) {
			// Metadata has committed. Reconciliation retries physical cleanup.
			fmt.Fprintln(os.Stderr, "chat image cleanup deferred")
		}
	}
	c.notify()
}

func (c *chatStore) reconcile(workspace state) error {
	accounts := make(map[string]bool, len(workspace.Accounts))
	for _, account := range workspace.Accounts {
		accounts[account.ID] = true
	}
	removed := []uint64{}
	err := c.db.Update(func(tx *bolt.Tx) error {
		var orphaned []string
		if err := tx.Bucket(forumBucket).ForEachBucket(func(key []byte) error {
			conversation := string(key)
			_, channel := workspace.Channels[conversation]
			a, b, direct := directParticipants(conversation)
			if !channel && !(direct && accounts[a] && accounts[b]) {
				orphaned = append(orphaned, conversation)
			}
			return nil
		}); err != nil {
			return err
		}
		for _, name := range orphaned {
			if err := dropChatChannel(tx, name, &removed); err != nil {
				return err
			}
		}
		var missing []uint64
		if err := tx.Bucket(mediaBucket).ForEach(func(key, value []byte) error {
			id := seqValue(key)
			stat, err := os.Stat(c.imagePath(id))
			if os.IsNotExist(err) || err == nil && uint64(stat.Size()) != seqValue(value) {
				missing = append(missing, id)
				return nil
			}
			return err
		}); err != nil {
			return err
		}
		for _, id := range missing {
			if err := expireImage(tx, id, &removed); err != nil {
				return err
			}
		}
		return c.prune(tx, &removed)
	})
	if err != nil {
		return err
	}
	c.finish(removed)
	entries, err := os.ReadDir(c.images)
	if err != nil {
		return err
	}
	return c.db.View(func(tx *bolt.Tx) error {
		for _, file := range entries {
			id, numeric := strconv.ParseUint(strings.TrimSuffix(file.Name(), ".blob"), 10, 64)
			isBlob := numeric == nil && file.Name() == filepath.Base(c.imagePath(id))
			if !file.IsDir() && (strings.HasPrefix(file.Name(), ".pending-") || isBlob && tx.Bucket(mediaBucket).Get(seqKey(id)) == nil) {
				if err := os.Remove(filepath.Join(c.images, file.Name())); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (c *chatStore) image(channel string, id uint64) (*os.File, chatMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var item chatMessage
	err := c.db.View(func(tx *bolt.Tx) error {
		_, found, err := chatItem(tx, id)
		item = found
		if err == nil && (item.Channel != channel || item.Image == "") {
			return errMissing
		}
		return err
	})
	if err != nil {
		return nil, item, err
	}
	f, err := os.Open(c.imagePath(id))
	return f, item, err
}
