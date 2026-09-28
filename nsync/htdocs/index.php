<?php

declare(strict_types=1);

/**
 * Note Sync API: token-scoped save, list, read, mark-as-read, and delete for
 * Pebble Index 01.
 */

// New files are created as 0640. Directory modes passed to mkdir stay 0750.
umask(0027);

require_once dirname(__DIR__) . '/lib/ollama-note-title.php';

const NOTE_FILENAME_PATTERN = '/^[0-9]{12}\.[A-Za-z0-9]{8}\.md$/';
const STORE_KEY_PATTERN = '/^[A-Za-z0-9]{16}$/';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_NOTE_CHARS = 20000;
const DEDUP_WINDOW_SECONDS = 14400;
const OLLAMA_MAX_TIMEOUT_SECONDS = 40;
const OLLAMA_MAX_COLD_TIMEOUT_SECONDS = 60;

// Web requests run the router. CLI can set NSYNC_LIBRARY=1 to load functions only.
if (PHP_SAPI !== 'cli' || getenv('NSYNC_LIBRARY') !== '1') {
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';

    if ($method === 'GET' && $action !== 'list' && $action !== 'read' && $action !== 'delete' && $action !== 'markasread') {
        http_response_code(403);
        exit;
    }

    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('Pragma: no-cache');

    $config = loadConfig();
    $timezone = timezoneFromConfig($config);
    setLogTimezone($timezone);

    writeLog('INFO', 'incoming ' . requestSummary());

    $identity = authenticate($config);
    writeLog('INFO', 'auth ok device=' . ($identity['devicename'] !== '' ? $identity['devicename'] : '-') . ' store=' . $identity['store_key']);
    collectOldLogs($config);
    $storeDir = dirname(__DIR__) . '/store/' . $identity['store_key'];
    ensureDirectory($storeDir);
    collectOldSyncedNotes($storeDir, $config);

    match ($method) {
        'POST' => handlePost($storeDir, $identity['devicename'], $timezone, $config, $identity['ollama']),
        'GET' => handleGet($storeDir, $timezone, $identity['devicename'], $config, $identity['store_key']),
        default => sendJson(400, ['error' => 'bad request'], 'bad method'),
    };
}

/**
 * Loads the project config from outside the webroot.
 *
 * @return array<string, mixed>
 */
function loadConfig(): array
{
    $path = dirname(__DIR__) . '/config.php';
    if (!is_file($path)) {
        refuse('missing_config');
    }

    $config = require $path;
    if (!is_array($config)) {
        refuse('invalid_config');
    }

    return $config;
}

/**
 * Resolves the timezone used for recordedAt and frontmatter timestamps.
 *
 * @param array<string, mixed> $config
 */
function timezoneFromConfig(array $config): DateTimeZone
{
    $name = $config['timezone'] ?? date_default_timezone_get();
    if (!is_string($name) || $name === '') {
        $name = date_default_timezone_get();
    }

    try {
        return new DateTimeZone($name);
    } catch (Exception) {
        return new DateTimeZone(date_default_timezone_get());
    }
}

/**
 * Validates the Token header and returns store key plus device name.
 *
 * @param array<string, mixed> $config
 * @return array{store_key: string, devicename: string, ollama: bool}
 */
function authenticate(array $config): array
{
    $provided = $_SERVER['HTTP_TOKEN'] ?? '';
    if (!is_string($provided) || strlen($provided) < 6) {
        refuse('short_token');
    }

    $tokens = $config['tokens'] ?? [];
    if (!is_array($tokens)) {
        refuse('invalid_tokens');
    }

    foreach ($tokens as $token => $settings) {
        if (!is_string($token) || strlen($token) < 6 || !is_array($settings)) {
            continue;
        }

        $storeKey = $settings['store_key'] ?? '';
        if (!is_string($storeKey) || preg_match(STORE_KEY_PATTERN, $storeKey) !== 1) {
            continue;
        }

        if (!hash_equals($token, $provided)) {
            continue;
        }

        $devicename = $settings['devicename'] ?? '';
        return [
            'store_key' => $storeKey,
            'devicename' => is_string($devicename) ? trim($devicename) : '',
            // Per-token opt-in; the global ollama.enabled must also be true.
            'ollama' => ($settings['ollama'] ?? false) === true,
        ];
    }

    refuse('unknown_token');
}

/**
 * Appends one line to log/YYYYMMDD.log. Does not write tokens or note bodies.
 */
function writeLog(string $level, string $message): void
{
    $dir = dirname(__DIR__) . '/log';
    if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
        return;
    }

    $now = new DateTimeImmutable('now', logTimezone());
    $path = $dir . '/' . $now->format('Ymd') . '.log';
    $line = $now->format('Y-m-d\TH:i:s') . ' [' . $level . '] ' . $message . "\n";
    file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
    chmod($path, 0640);
}

/**
 * Sets the timezone used for log filenames and timestamps. Called once per
 * request with the configured timezone; kept in a global so every writeLog
 * call site (refuse, sendJson, GC) uses it without threading a parameter.
 */
function setLogTimezone(DateTimeZone $timezone): void
{
    $GLOBALS['log_timezone'] = $timezone;
}

/**
 * Returns the log timezone, or the PHP default when the config could not be
 * loaded (e.g. the missing-config refusal path).
 */
function logTimezone(): DateTimeZone
{
    if (isset($GLOBALS['log_timezone']) && $GLOBALS['log_timezone'] instanceof DateTimeZone) {
        return $GLOBALS['log_timezone'];
    }

    return new DateTimeZone(date_default_timezone_get());
}

/**
 * Builds a short incoming-request summary without secrets.
 */
function requestSummary(): string
{
    $method = $_SERVER['REQUEST_METHOD'] ?? '-';
    $uri = $_SERVER['REQUEST_URI'] ?? '-';
    $ip = $_SERVER['REMOTE_ADDR'] ?? '-';
    $action = $_GET['action'] ?? '-';
    $token = $_SERVER['HTTP_TOKEN'] ?? '';
    $tokenLen = is_string($token) ? (string) strlen($token) : '0';

    return 'method=' . $method
        . ' uri=' . $uri
        . ' action=' . (is_string($action) && $action !== '' ? $action : '-')
        . ' ip=' . $ip
        . ' token_len=' . $tokenLen;
}

/**
 * Refuses the request with an empty 403 body.
 *
 * @return never
 */
function refuse(string $reason = 'forbidden'): never
{
    writeLog('WARN', 'refuse reason=' . $reason . ' ' . requestSummary());
    http_response_code(403);
    exit;
}

/**
 * Sends a JSON body and stops execution.
 *
 * @param array<string, mixed>|list<array<string, string>> $payload
 * @return never
 */
function sendJson(int $status, array $payload, string $event = ''): never
{
    $detail = $event !== '' ? $event : 'response';
    $line = $detail . ' status=' . $status;
    if ($status >= 500) {
        writeLog('ERROR', $line);
    } elseif ($status >= 400) {
        writeLog('WARN', $line);
    } else {
        writeLog('INFO', 'success ' . $line);
    }

    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

/**
 * Creates a directory with mode 0750 when it does not exist.
 */
function ensureDirectory(string $path): void
{
    if (is_dir($path)) {
        return;
    }

    if (!mkdir($path, 0750, true) && !is_dir($path)) {
        sendJson(500, ['error' => 'storage unavailable'], 'mkdir failed path_ok=0');
    }
}

/**
 * Saves a new note from Pebble multipart POST fields.
 *
 * @param array<string, mixed> $config
 *
 * @return never
 */
function handlePost(string $storeDir, string $devicename, DateTimeZone $timezone, array $config, bool $allowOllama): never
{
    $transcription = $_POST['transcription'] ?? '';
    if (!is_string($transcription)) {
        sendJson(400, ['error' => 'bad request'], 'POST missing transcription');
    }

    $body = trim($transcription);
    $bodyLen = contentLength($body);
    if ($bodyLen < 8) {
        sendJson(200, ['skipped' => true, 'reason' => 'too_short'], 'POST skip too_short len=' . $bodyLen);
    }
    if ($bodyLen > MAX_NOTE_CHARS) {
        sendJson(413, ['error' => 'note too large'], 'POST too_large len=' . $bodyLen);
    }

    $recordedAt = parseRecordedAt($_POST['recordedAt'] ?? null);
    if ($recordedAt === null) {
        sendJson(400, ['error' => 'bad request'], 'POST invalid recordedAt');
    }

    $created = $recordedAt->setTimezone($timezone);
    if (strlen($created->format('Y')) !== 4) {
        sendJson(400, ['error' => 'bad request'], 'POST recordedAt out of range');
    }

    $existing = findDuplicateNote($storeDir, $body);
    if ($existing !== null) {
        sendJson(200, ['skipped' => true, 'reason' => 'duplicate', 'filename' => $existing], 'POST skip duplicate len=' . $bodyLen);
    }

    $client = $_POST['client'] ?? '';
    $client = is_string($client) ? ollamaSanitizeTitle($client) : '';
    $device = ollamaSanitizeTitle($devicename !== '' ? $devicename : $client);

    // A client-supplied title wins and skips the optional Ollama call entirely.
    // The note is stored first so a slow or failed model cannot drop the memo.
    $providedTitle = $_POST['title'] ?? '';
    $providedTitle = is_string($providedTitle) ? ollamaSanitizeTitle($providedTitle) : '';
    $title = $providedTitle !== '' ? $providedTitle : noteTitle($device, $created);
    $titleSource = $providedTitle !== '' ? 'client' : 'timestamp';

    $iso = $created->format('Y-m-d\TH:i:s');
    $markdown = buildMarkdown($title, $iso, hash('sha256', $body), time(), $body);
    $filename = createNoteFile($storeDir, $created, $markdown);
    if ($filename === null) {
        sendJson(500, ['error' => 'storage unavailable'], 'POST write failed');
    }

    if ($providedTitle === '') {
        $generated = ollamaTitle($body, $config, $allowOllama);
        if ($generated !== null) {
            $path = $storeDir . DIRECTORY_SEPARATOR . $filename;
            if (replaceNoteTitle($path, $generated)) {
                $titleSource = 'ollama';
            } else {
                writeLog('WARN', 'ollama title not stored filename=' . $filename);
            }
        }
    }

    sendJson(200, ['filename' => $filename], 'POST save filename=' . $filename . ' title_source=' . $titleSource);
}

/**
 * Counts characters in note body (UTF-8 when mbstring is available).
 */
function contentLength(string $text): int
{
    if (function_exists('mb_strlen')) {
        return (int) mb_strlen($text, 'UTF-8');
    }

    return strlen($text);
}

/**
 * Returns the filename of a note with the same body stored within the last
 * DEDUP_WINDOW_SECONDS (by server stored-at), or null when none exists.
 */
function findDuplicateNote(string $storeDir, string $body): ?string
{
    $hash = hash('sha256', $body);
    $cutoff = time() - DEDUP_WINDOW_SECONDS;
    $files = scandir($storeDir);
    if ($files === false) {
        return null;
    }

    foreach ($files as $filename) {
        if (preg_match(NOTE_FILENAME_PATTERN, $filename) !== 1) {
            continue;
        }

        $path = $storeDir . DIRECTORY_SEPARATOR . $filename;
        $meta = parseFrontmatter(file_get_contents($path) ?: '');
        if ($meta['stored-at'] === '' || (int) $meta['stored-at'] < $cutoff) {
            continue;
        }
        if (hash_equals($meta['hash'], $hash)) {
            return $filename;
        }
    }

    return null;
}

/**
 * Reads a positive integer from config gc.<key>, or $default when missing.
 *
 * @param array<string, mixed> $config
 */
function gcDays(array $config, string $key, int $default): int
{
    $gc = $config['gc'] ?? [];
    if (!is_array($gc) || !isset($gc[$key]) || !is_numeric($gc[$key])) {
        return $default;
    }

    return max(0, (int) $gc[$key]);
}

/**
 * Deletes log/YYYYMMDD.log files older than gc.log_days.
 *
 * @param array<string, mixed> $config
 */
function collectOldLogs(array $config): void
{
    $days = gcDays($config, 'log_days', 7);
    if ($days < 1) {
        return;
    }

    $dir = dirname(__DIR__) . '/log';
    if (!is_dir($dir)) {
        return;
    }

    $tz = timezoneFromConfig($config);
    $cutoff = (new DateTimeImmutable('now', $tz))->modify('-' . $days . ' days')->format('Ymd');
    $deleted = 0;
    $files = scandir($dir);
    if ($files === false) {
        return;
    }

    foreach ($files as $file) {
        if (preg_match('/^(\d{8})\.log$/', $file, $match) !== 1) {
            continue;
        }
        if ($match[1] >= $cutoff) {
            continue;
        }

        $path = $dir . DIRECTORY_SEPARATOR . $file;
        if (is_file($path) && unlink($path)) {
            $deleted++;
        }
    }

    if ($deleted > 0) {
        writeLog('INFO', 'gc deleted logs=' . $deleted . ' cutoff=' . $cutoff);
    }
}

/**
 * Deletes synced notes whose modified timestamp is older than gc.synced_note_days.
 * Notes without last-sync are kept.
 *
 * @param array<string, mixed> $config
 */
function collectOldSyncedNotes(string $storeDir, array $config): void
{
    $days = gcDays($config, 'synced_note_days', 30);
    if ($days < 1 || !is_dir($storeDir)) {
        return;
    }

    $tz = timezoneFromConfig($config);
    $cutoff = (new DateTimeImmutable('now', $tz))->modify('-' . $days . ' days');
    $deleted = 0;
    $files = scandir($storeDir);
    if ($files === false) {
        return;
    }

    foreach ($files as $filename) {
        if (preg_match(NOTE_FILENAME_PATTERN, $filename) !== 1) {
            continue;
        }

        $path = $storeDir . DIRECTORY_SEPARATOR . $filename;
        if (!is_file($path)) {
            continue;
        }

        $meta = parseFrontmatter(file_get_contents($path) ?: '');
        if ($meta['last-sync'] === '') {
            continue;
        }

        $modified = parseStoredAt($meta['stored-at']) ?? parseFrontmatterTime($meta['modified'], $tz);
        if ($modified === null || $modified > $cutoff) {
            continue;
        }

        if (unlink($path)) {
            $deleted++;
        }
    }

    if ($deleted > 0) {
        writeLog('INFO', 'gc deleted synced notes=' . $deleted . ' older_than_days=' . $days);
    }
}

/**
 * Parses a frontmatter timestamp Y-m-d\TH:i:s in the given timezone.
 */
function parseFrontmatterTime(string $value, DateTimeZone $timezone): ?DateTimeImmutable
{
    if ($value === '') {
        return null;
    }

    $dt = DateTimeImmutable::createFromFormat('Y-m-d\TH:i:s', $value, $timezone);
    return $dt === false ? null : $dt;
}

/**
 * Parses a stored-at unix timestamp (server time), or null when invalid.
 */
function parseStoredAt(string $value): ?DateTimeImmutable
{
    if ($value === '' || !ctype_digit($value)) {
        return null;
    }

    $dt = DateTimeImmutable::createFromFormat('U', $value);
    return $dt === false ? null : $dt;
}

/**
 * Parses recordedAt milliseconds into a DateTimeImmutable, or null if invalid.
 */
function parseRecordedAt(mixed $value): ?DateTimeImmutable
{
    if (!is_string($value) && !is_int($value) && !is_float($value)) {
        return null;
    }

    $raw = trim((string) $value);
    if ($raw === '' || !ctype_digit($raw)) {
        return null;
    }

    $seconds = intdiv((int) $raw, 1000);
    $dt = DateTimeImmutable::createFromFormat('U', (string) $seconds);
    return $dt === false ? null : $dt;
}

/**
 * Returns the Ollama settings when optional title generation is enabled and
 * minimally configured, or null when it is off, disabled, or misconfigured.
 *
 * @param array<string, mixed> $config
 * @return array{url: string, model: string, timeout_seconds: int, cold_timeout_seconds: int, keep_alive: string, options: array<string, mixed>}|null
 */
function ollamaConfig(array $config): ?array
{
    $ollama = $config['ollama'] ?? null;
    if (!is_array($ollama) || ($ollama['enabled'] ?? false) !== true) {
        return null;
    }

    $url = is_string($ollama['url'] ?? null) ? trim($ollama['url']) : '';
    $model = is_string($ollama['model'] ?? null) ? trim($ollama['model']) : '';
    if ($url === '' || $model === '') {
        writeLog('WARN', 'ollama enabled but url/model missing; keeping timestamp titles');
        return null;
    }

    $defaults = ollamaDefaults();
    $timeout = $ollama['timeout_seconds'] ?? $defaults['timeout_seconds'];
    $coldTimeout = $ollama['cold_timeout_seconds'] ?? $defaults['cold_timeout_seconds'];
    $keepAlive = $ollama['keep_alive'] ?? $defaults['keep_alive'];
    $options = $ollama['options'] ?? $defaults['options'];

    return [
        'url' => $url,
        'model' => $model,
        'timeout_seconds' => capOllamaTimeout($timeout, $defaults['timeout_seconds'], OLLAMA_MAX_TIMEOUT_SECONDS),
        'cold_timeout_seconds' => capOllamaTimeout($coldTimeout, $defaults['cold_timeout_seconds'], OLLAMA_MAX_COLD_TIMEOUT_SECONDS),
        'keep_alive' => is_string($keepAlive) && $keepAlive !== '' ? $keepAlive : $defaults['keep_alive'],
        'options' => is_array($options) ? $options : $defaults['options'],
    ];
}

/**
 * Caps an Ollama timeout so one title call cannot hold a PHP worker past the
 * pool request limit. Values below 1 fall back to the built-in default, then
 * $max is applied. Cold loads use a higher $max because the model has to be
 * read from disk first.
 */
function capOllamaTimeout(mixed $value, int $fallback, int $max): int
{
    $seconds = is_numeric($value) ? (int) $value : $fallback;
    if ($seconds < 1) {
        $seconds = $fallback;
    }

    return min($max, $seconds);
}

/**
 * Returns an LLM-written title, or null when the feature is disabled, the token
 * is not allowed to use it, another request already holds the model, or the
 * model is unreachable. Never throws. The note is already stored with a
 * timestamp title, so a miss here only keeps that title.
 *
 * @param array<string, mixed> $config
 */
function ollamaTitle(string $body, array $config, bool $allowOllama): ?string
{
    if (!$allowOllama) {
        return null;
    }

    $ollama = ollamaConfig($config);
    if ($ollama === null) {
        return null;
    }

    $lockPath = dirname(__DIR__) . '/log/ollama.lock';
    $lock = fopen($lockPath, 'c');
    if ($lock === false) {
        writeLog('WARN', 'ollama lock unavailable');
        return null;
    }

    try {
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            writeLog('WARN', 'ollama busy; keeping timestamp title');
            return null;
        }

        try {
            $title = ollamaNoteTitle($body, $ollama);
        } catch (Throwable $e) {
            writeLog('WARN', 'ollama title failed: ' . $e->getMessage());
            return null;
        }

        return $title !== '' ? $title : null;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/**
 * Builds the note title: "Note {device} {D j M H:i}".
 */
function noteTitle(string $device, DateTimeImmutable $created): string
{
    $parts = ['Note'];
    if ($device !== '') {
        $parts[] = $device;
    }
    $parts[] = $created->format('D j M H:i');

    return implode(' ', $parts);
}

/**
 * Removes control characters from an unquoted frontmatter value so it stays
 * on one line.
 */
function frontmatterPlain(string $value): string
{
    $clean = preg_replace('/[\x00-\x1F\x7F]/', '', $value);
    return is_string($clean) ? trim($clean) : '';
}

/**
 * Escapes a value for a double-quoted YAML scalar. Line breaks and other
 * control characters are removed so the value stays on one line.
 */
function yamlQuoted(string $value): string
{
    $value = str_replace(["\r\n", "\r", "\n"], ' ', $value);
    $stripped = preg_replace('/[\x00-\x1F\x7F]/', '', $value);
    if (is_string($stripped)) {
        $value = $stripped;
    }

    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
}

/**
 * Builds markdown with the required frontmatter block.
 */
function buildMarkdown(string $title, string $iso, string $hash, int $storedAt, string $body): string
{
    return "---\n"
        . 'title: ' . yamlQuoted($title) . "\n"
        . 'date: ' . $iso . "\n"
        . 'modified: ' . $iso . "\n"
        . 'stored-at: ' . $storedAt . "\n"
        . 'hash: ' . $hash . "\n"
        . "---\n"
        . $body
        . (str_ends_with($body, "\n") ? '' : "\n");
}

/**
 * Returns a cryptographically random alphanumeric string.
 */
function randomAlnum(int $length): string
{
    $max = strlen(ALNUM) - 1;
    $out = '';
    for ($i = 0; $i < $length; $i++) {
        $out .= ALNUM[random_int(0, $max)];
    }

    return $out;
}

/**
 * Creates a new note with an exclusive write so an existing name is never
 * overwritten. Returns the filename, or null when the write fails.
 */
function createNoteFile(string $storeDir, DateTimeImmutable $created, string $markdown): ?string
{
    $prefix = $created->format('YmdHi');
    if (strlen($prefix) !== 12) {
        return null;
    }

    for ($attempt = 0; $attempt < 3; $attempt++) {
        $filename = $prefix . '.' . randomAlnum(8) . '.md';
        $path = $storeDir . DIRECTORY_SEPARATOR . $filename;
        $fh = fopen($path, 'xb');
        if ($fh === false) {
            continue;
        }

        $written = fwrite($fh, $markdown);
        fclose($fh);
        if ($written !== strlen($markdown)) {
            unlink($path);
            return null;
        }

        chmod($path, 0640);
        return $filename;
    }

    return null;
}

/**
 * Routes GET actions for list, read, mark-as-read, and delete.
 *
 * @param array<string, mixed> $config
 */
function handleGet(string $storeDir, DateTimeZone $timezone, string $devicename, array $config, string $storeKey): never
{
    $action = $_GET['action'] ?? '';

    if ($action === 'list') {
        $notes = listNotes($storeDir, $devicename);
        sendJson(200, $notes, 'GET list count=' . count($notes));
    }

    if ($action === 'read') {
        $filename = filenameFromQuery();
        $content = readNote($storeDir, $filename);
        stampLastSync($storeDir, $filename, $timezone, $devicename, $storeKey, $config);
        sendJson(200, ['content' => $content], 'GET read filename=' . $filename);
    }

    if ($action === 'markasread') {
        markAsRead($storeDir, filenameFromQuery(), $devicename);
    }

    if ($action === 'delete') {
        deleteNote($storeDir, filenameFromQuery());
    }

    sendJson(400, ['error' => 'bad request'], 'GET unknown action');
}

/**
 * Returns and validates the filename query parameter.
 */
function filenameFromQuery(): string
{
    $filename = $_GET['filename'] ?? '';
    if (!is_string($filename) || preg_match(NOTE_FILENAME_PATTERN, $filename) !== 1) {
        sendJson(400, ['error' => 'bad request'], 'invalid filename');
    }

    return $filename;
}

/**
 * Resolves a note path inside the token store directory.
 */
function resolveNotePath(string $storeDir, string $filename): string
{
    $storeReal = realpath($storeDir);
    if ($storeReal === false) {
        sendJson(500, ['error' => 'storage unavailable'], 'store realpath failed');
    }

    $candidate = $storeReal . DIRECTORY_SEPARATOR . $filename;
    $real = realpath($candidate);
    if ($real === false) {
        sendJson(404, ['error' => 'not found'], 'note missing filename=' . $filename);
    }

    if (!str_starts_with($real, $storeReal . DIRECTORY_SEPARATOR)) {
        sendJson(400, ['error' => 'bad request'], 'path escape filename=' . $filename);
    }

    return $real;
}

/**
 * Lists notes belonging to the authenticated token, excluding notes that
 * this token's device already marked as read (readby).
 *
 * @return list<array{filename: string, date: string, lastmodified: string, title: string}>
 */
function listNotes(string $storeDir, string $devicename): array
{
    $entries = [];
    $files = scandir($storeDir);
    if ($files === false) {
        return $entries;
    }

    $reader = normalizeDeviceName($devicename);

    foreach ($files as $filename) {
        if (preg_match(NOTE_FILENAME_PATTERN, $filename) !== 1) {
            continue;
        }

        $path = $storeDir . DIRECTORY_SEPARATOR . $filename;
        if (!is_file($path)) {
            continue;
        }

        $meta = parseFrontmatter(file_get_contents($path) ?: '');
        if ($meta['readby'] !== '' && $meta['readby'] === $reader) {
            continue;
        }

        $mtime = date('Y-m-d\TH:i:s', (int) filemtime($path));

        $entries[] = [
            'filename' => $filename,
            'date' => $meta['date'] !== '' ? $meta['date'] : $mtime,
            'lastmodified' => $meta['modified'] !== '' ? $meta['modified'] : $mtime,
            'title' => $meta['title'],
        ];
    }

    return $entries;
}

/**
 * Returns the full markdown of a note, including frontmatter.
 */
function readNote(string $storeDir, string $filename): string
{
    $path = resolveNotePath($storeDir, $filename);
    $content = file_get_contents($path);
    if ($content === false) {
        sendJson(404, ['error' => 'not found'], 'read failed filename=' . $filename);
    }

    return stripInternalFields($content);
}

/**
 * Removes the internal last-sync, synced, and readby lines so clients never
 * receive server-side sync/marking state, even when a note has been read or
 * marked before. Files without a frontmatter block are returned unchanged.
 */
function stripInternalFields(string $content): string
{
    $split = splitMarkdown($content);
    if (
        !str_starts_with($content, "---\n")
        || ($split['meta']['title'] === '' && $split['meta']['date'] === '' && $split['meta']['modified'] === '')
    ) {
        return $content;
    }

    $split['meta']['last-sync'] = '';
    $split['meta']['readby'] = '';
    $split['meta']['synced'] = '';
    return buildMarkdownFromMeta($split['meta'], $split['body']);
}

/**
 * Applies $update to a note under an exclusive lock and writes the result
 * back. $update receives the current contents and returns the replacement.
 * Returns false when the file cannot be locked or written.
 *
 * @param callable(string): string $update
 */
function updateNoteLocked(string $path, callable $update): bool
{
    $fh = fopen($path, 'r+b');
    if ($fh === false) {
        return false;
    }

    try {
        if (!flock($fh, LOCK_EX)) {
            return false;
        }

        $content = stream_get_contents($fh);
        if (!is_string($content)) {
            return false;
        }

        $updated = $update($content);
        if (!is_string($updated)) {
            return false;
        }

        if ($updated === $content) {
            return true;
        }

        if (!rewind($fh) || !ftruncate($fh, 0)) {
            return false;
        }

        $written = fwrite($fh, $updated);
        if ($written !== strlen($updated)) {
            return false;
        }

        fflush($fh);
        chmod($path, 0640);
        return true;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

/**
 * Replaces the frontmatter title and keeps every other field and the body.
 */
function replaceNoteTitle(string $path, string $title): bool
{
    return updateNoteLocked($path, function (string $content) use ($title): string {
        $split = splitMarkdown($content);
        $split['meta']['title'] = $title;
        return buildMarkdownFromMeta($split['meta'], $split['body']);
    });
}

/**
 * Records that this device has read the note. last-sync is written only when
 * every named device that shares the store has read it, so one client cannot
 * start the deletion clock for the others. A store used by one device still
 * stamps on that read. Does not change the JSON body.
 *
 * @param array<string, mixed> $config
 */
function stampLastSync(
    string $storeDir,
    string $filename,
    DateTimeZone $timezone,
    string $devicename,
    string $storeKey,
    array $config
): void {
    $path = resolveNotePath($storeDir, $filename);
    $device = normalizeDeviceName($devicename);
    $required = storeDeviceNames($config, $storeKey);
    $stamp = (new DateTimeImmutable('now', $timezone))->format('Y-m-d\TH:i:s');

    $ok = updateNoteLocked($path, function (string $content) use ($device, $required, $stamp): string {
        $split = splitMarkdown($content);
        $synced = parseSyncedDevices($split['meta']['synced']);
        if ($device !== '') {
            $synced[$device] = true;
        }

        $names = array_keys($synced);
        sort($names);
        $split['meta']['synced'] = implode(',', $names);
        if (array_diff($required, $names) === []) {
            $split['meta']['last-sync'] = $stamp;
        }

        return buildMarkdownFromMeta($split['meta'], $split['body']);
    });

    if (!$ok) {
        writeLog('WARN', 'last-sync write failed filename=' . $filename);
    }
}

/**
 * Normalized device names of every token that uses this store.
 *
 * @param array<string, mixed> $config
 * @return list<string>
 */
function storeDeviceNames(array $config, string $storeKey): array
{
    $names = [];
    $tokens = $config['tokens'] ?? [];
    if (!is_array($tokens)) {
        return [];
    }

    foreach ($tokens as $settings) {
        if (!is_array($settings)) {
            continue;
        }

        $key = $settings['store_key'] ?? '';
        if (!is_string($key) || $key !== $storeKey) {
            continue;
        }

        $device = $settings['devicename'] ?? '';
        $name = normalizeDeviceName(is_string($device) ? $device : '');
        if ($name !== '') {
            $names[$name] = true;
        }
    }

    return array_keys($names);
}

/**
 * Splits a synced-device list into a set of normalized names.
 *
 * @return array<string, true>
 */
function parseSyncedDevices(string $value): array
{
    $set = [];
    foreach (explode(',', $value) as $part) {
        $name = normalizeDeviceName($part);
        if ($name !== '') {
            $set[$name] = true;
        }
    }

    return $set;
}

/**
 * Splits markdown into frontmatter fields and body.
 *
 * @return array{meta: array{title: string, date: string, modified: string, stored-at: string, hash: string, last-sync: string, readby: string, synced: string}, body: string}
 */
function splitMarkdown(string $content): array
{
    $meta = [
        'title' => '',
        'date' => '',
        'modified' => '',
        'stored-at' => '',
        'hash' => '',
        'last-sync' => '',
        'readby' => '',
        'synced' => '',
    ];
    $body = $content;

    if (str_starts_with($content, "---\n")) {
        $end = strpos($content, "\n---\n", 4);
        if ($end !== false) {
            $block = substr($content, 4, $end - 4);
            $body = substr($content, $end + 5);
            foreach (explode("\n", $block) as $line) {
                $pos = strpos($line, ':');
                if ($pos === false) {
                    continue;
                }

                $key = trim(substr($line, 0, $pos));
                $value = trim(substr($line, $pos + 1));
                if (strlen($value) >= 2 && $value[0] === '"' && str_ends_with($value, '"')) {
                    $value = stripcslashes(substr($value, 1, -1));
                }

                if (array_key_exists($key, $meta)) {
                    $meta[$key] = $value;
                }
            }
        }
    }

    return ['meta' => $meta, 'body' => $body];
}

/**
 * Rebuilds markdown from known frontmatter fields, omitting empty ones.
 *
 * @param array{title: string, date: string, modified: string, stored-at: string, hash: string, last-sync: string, readby: string, synced: string} $meta
 */
function buildMarkdownFromMeta(array $meta, string $body): string
{
    $out = "---\n"
        . 'title: ' . yamlQuoted($meta['title']) . "\n"
        . 'date: ' . frontmatterPlain($meta['date']) . "\n"
        . 'modified: ' . frontmatterPlain($meta['modified']) . "\n";
    if ($meta['stored-at'] !== '') {
        $out .= 'stored-at: ' . frontmatterPlain($meta['stored-at']) . "\n";
    }
    if ($meta['hash'] !== '') {
        $out .= 'hash: ' . frontmatterPlain($meta['hash']) . "\n";
    }
    if ($meta['last-sync'] !== '') {
        $out .= 'last-sync: ' . frontmatterPlain($meta['last-sync']) . "\n";
    }
    if ($meta['readby'] !== '') {
        $out .= 'readby: ' . frontmatterPlain($meta['readby']) . "\n";
    }
    $synced = preg_replace('/[^a-z0-9,]/', '', strtolower($meta['synced']));
    if (is_string($synced) && $synced !== '') {
        $out .= 'synced: ' . $synced . "\n";
    }

    return $out
        . "---\n"
        . $body
        . (str_ends_with($body, "\n") ? '' : "\n");
}

/**
 * Parses a simple --- YAML-like frontmatter block.
 *
 * @return array{title: string, date: string, modified: string, stored-at: string, hash: string, last-sync: string, readby: string, synced: string}
 */
function parseFrontmatter(string $content): array
{
    return splitMarkdown($content)['meta'];
}

/**
 * Deletes a note in the authenticated token store.
 *
 * @return never
 */
function deleteNote(string $storeDir, string $filename): never
{
    $path = resolveNotePath($storeDir, $filename);
    if (!unlink($path)) {
        sendJson(500, ['error' => 'not found'], 'delete failed filename=' . $filename);
    }

    sendJson(200, ['ok' => true], 'GET delete filename=' . $filename);
}

/**
 * Simplifies a device name for safe frontmatter storage: lowercased, trimmed,
 * alphanumeric characters only.
 */
function normalizeDeviceName(string $devicename): string
{
    $name = strtolower(trim($devicename));
    $cleaned = preg_replace('/[^a-z0-9]+/', '', $name);

    return is_string($cleaned) ? $cleaned : '';
}

/**
 * Marks a note as read for the requesting client (a per-client soft delete):
 * writes the client's simplified device name into the frontmatter `readby`
 * line. The note is no longer listed for this client but stays in the store.
 *
 * @return never
 */
function markAsRead(string $storeDir, string $filename, string $devicename): never
{
    $device = normalizeDeviceName($devicename);
    if ($device === '') {
        sendJson(400, ['error' => 'bad request'], 'GET markasread no devicename');
    }

    $path = resolveNotePath($storeDir, $filename);
    $ok = updateNoteLocked($path, function (string $content) use ($device): string {
        $split = splitMarkdown($content);
        $split['meta']['readby'] = $device;
        return buildMarkdownFromMeta($split['meta'], $split['body']);
    });
    if (!$ok) {
        sendJson(500, ['error' => 'storage unavailable'], 'markasread write failed');
    }

    sendJson(200, ['ok' => true], 'GET markasread filename=' . $filename . ' device=' . $device);
}
