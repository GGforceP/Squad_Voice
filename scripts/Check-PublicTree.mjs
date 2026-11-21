import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flags = process.argv.slice(2);
const staged = flags.length === 1 && flags[0] === '--staged';
const worktree = flags.length === 1 && flags[0] === '--worktree';
const seenPaths = new Set();
const seenVersions = new Set();
const failures = [];

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git could not read the requested public source.');
  return result.stdout;
}

const runtimePath = /(?:^|\/)(?:\.git|\.cache|\.deps|node_modules|vendor|config|Client-Installer|Data|dist(?:-qa)?|artifacts|build|tmp)(?:\/|$)/i;
const runtimeFile = /(?:^|\/)(?:\.env(?!\.example$)[^/]*|state\.json|keys\.json|geo\.json|update-key\.json|release\.json|id_(?:rsa|ed25519)(?:\.pub)?|known_hosts)$/i;
const binaryFile = /\.(?:pem|key|crt|cer|pfx|p12|dpapi|db|sqlite\w*|log|exe|dll|zip|gz|tar|nupkg|p7s)$/i;
// Keep the hashes of reviewed screenshots that remain in public history.
const reviewedReadmeImages = new Map([
  ['assets/readme/01-login.png', ['9fa0a725a64b44a9da829c9600e5eb626ba7ad8ae9250afbec1d5b042b39836f']],
  ['assets/readme/02-channel-preview.png', ['e341b706fd9b06ccd3eb627e2cd861c5ed2cf9255daa4a87ea491b0e8530a1d4']],
  ['assets/readme/03-voice-chat.png', ['9c6e8b3e3248ec6d82da09c53c209cc1af316c18d447e467690a521dc8b478ad']],
  ['assets/readme/04-audio-settings.png', ['74a29ba70c877a95c1e72bbb22dee338bf761f933d383d57f8da96c725edbc79']],
  ['assets/readme/05-cache.png', ['a15b367cb9fc9e0b320485282ce68fb6309b0f745f17055bc275b792ede2e8a5']],
  ['assets/readme/06-update.png', ['949d7602ec0cd0b38941c6940d7aaabd0316376ec4e96df1ae8149844e845245']],
]);
const contentRules = [
  [/-----BEGIN (?:[A-Z]+ )*(?:PRIVATE KEY|CERTIFICATE)-----/i, 'private key or certificate material'],
  [/(?:gh[pousr]_[a-z0-9]{25,}|github_pat_[a-z0-9_]{40,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{16,})/i, 'access token'],
  [/https?:\/\/[^\s/<>"']+:[^\s/@<>"']+@/i, 'URL with embedded credentials'],
  [/https?:\/\/[^\s<>"']+[?&](?:token|access_token|api_key|password)=[^\s<>"']+/i, 'URL with a credential parameter'],
  [/(?:[a-z]:[\\/](?:users|documents)[\\/]|\/(?:home|Users)\/[a-z0-9_-]+\/)/i, 'personal machine path'],
  [/(?:^|[^a-z0-9+/=])[a-z0-9+/]{512}(?:[^a-z0-9+/=]|$)/i, 'embedded publisher key or binary material'],
  [/"passwordHash"\s*:\s*"argon2id\$/i, 'account data'],
];

function inspectContent(path, content) {
  if (content.includes('\0') || content.includes('\uFFFD')) failures.push([path, 'non-text data']);
  for (const [rule, problem] of contentRules) {
    if (rule.test(content)) failures.push([path, problem]);
  }
  for (const ipv4 of content.match(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g) ?? []) {
    if (isIP(ipv4) !== 4 || ipv4 === '0.0.0.0' || ipv4 === '100.64.0.0' ||
        /^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ipv4)) continue;
    failures.push([path, 'literal IPv4 address outside a documentation or loopback network']);
    break;
  }
  for (const ipv6 of content.match(/(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f:]{0,30}(?![\w:])/gi) ?? []) {
    if (isIP(ipv6) !== 6 || ipv6 === '::' || ipv6 === '::1' || /^2001:db8:/i.test(ipv6)) continue;
    failures.push([path, 'literal IPv6 address outside a documentation or loopback network']);
    break;
  }
}

function inspectPath(path) {
  if (seenPaths.has(path)) return;
  seenPaths.add(path);
  if (runtimePath.test(path) || runtimeFile.test(path) || binaryFile.test(path)) failures.push([path, 'deployment data or build output']);
}

function inspectFile(path, contents) {
  const reviewedHashes = reviewedReadmeImages.get(path);
  if (!reviewedHashes) {
    inspectContent(path, contents.toString('utf8'));
    return;
  }
  const hash = createHash('sha256').update(contents).digest('hex');
  if (!reviewedHashes.includes(hash)) failures.push([path, 'README screenshot differs from the reviewed image']);
}

function inspect(entries) {
  for (const entry of entries.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    inspectPath(path);
    if (mode !== '100644' && mode !== '100755') {
      failures.push([path, 'non-regular tracked file']);
      continue;
    }
    const oid = staged ? type : object;
    const version = path + '\0' + oid;
    if (seenVersions.has(version)) continue;
    seenVersions.add(version);
    inspectFile(path, git(['cat-file', 'blob', oid], null));
  }
}

if (worktree) {
  for (const path of new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))) {
    inspectPath(path);
    const file = join(root, path);
    if (!lstatSync(file).isFile()) { failures.push([path, 'non-regular source file']); continue; }
    inspectFile(path, readFileSync(file));
  }
} else if (staged) {
  inspect(git(['ls-files', '--stage', '-z']));
} else {
  const refs = flags.length ? flags : ['HEAD'];
  const commits = git(['rev-list', ...refs.map(ref => git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim())]).trim();
  for (const commit of commits.split('\n').filter(Boolean)) {
    inspectContent('commit ' + commit, git(['cat-file', 'commit', commit]));
    inspect(git(['ls-tree', '-r', '-z', commit]));
  }
}

if (seenPaths.size === 0) failures.push(['repository', 'no tracked source']);
if (failures.length) {
  for (const [path, issue] of failures) console.error(path + ' — ' + issue);
  process.exitCode = 1;
} else {
  console.log('Public source checked (' + seenPaths.size + ' paths' + (worktree ? '' : ', ' + seenVersions.size + ' file versions') + ').');
}
