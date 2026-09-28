<?php
declare(strict_types=1);

// Dumps are created as 0640. Directory modes passed to mkdir stay 0750.
umask(0027);



/**
 * Request capture endpoint for Pebble Index 01 payload discovery.
 * Writes a full dump to ../debug/<timestamp>.json when debug_capture is enabled.
 */

header('Content-Type: application/json; charset=utf-8');

$config = loadConfig();
if (!is_array($config) || ($config['debug_capture'] ?? false) !== true) {
    http_response_code(404);
    exit;
}

$debugDir = dirname(__DIR__) . '/debug';
ensureDirectory($debugDir);

$now = nowWithMicros();
$dump = buildDump($now);
$filename = $now->format('YmdHis') . '_' . $now->format('u') . '.json';
$path = $debugDir . '/' . $filename;

$json = json_encode($dump, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
file_put_contents($path, $json . "\n", LOCK_EX);
chmod($path, 0640);

echo json_encode(['ok' => true, 'saved' => $filename], JSON_THROW_ON_ERROR);

/**
 * Loads the project config from outside the webroot.
 *
 * @return array<string, mixed>
 */
function loadConfig(): array
{
    $path = dirname(__DIR__) . '/config.php';
    if (!is_file($path)) {
        return [];
    }

    $config = require $path;
    return is_array($config) ? $config : [];
}

/**
 * Creates a directory with mode 0750 when it does not exist.
 */
function ensureDirectory(string $path): void
{
    if (!is_dir($path) && !mkdir($path, 0750, true) && !is_dir($path)) {
        http_response_code(500);
        echo json_encode(['error' => 'unable to write dump'], JSON_THROW_ON_ERROR);
        exit;
    }
}

/**
 * Returns the current time with microsecond precision, locale-safe.
 */
function nowWithMicros(): DateTimeImmutable
{
    [$fraction, $seconds] = explode(' ', microtime());
    $usec = str_pad(substr($fraction, 2, 6), 6, '0');
    $now = DateTimeImmutable::createFromFormat('U.u', $seconds . '.' . $usec);
    if ($now === false) {
        return new DateTimeImmutable();
    }

    return $now->setTimezone(new DateTimeZone(date_default_timezone_get()));
}

/**
 * Collects request metadata needed to design the real API receiver.
 *
 * @return array<string, mixed>
 */
function buildDump(DateTimeImmutable $received): array
{
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false) {
        $rawBody = '';
    }

    $jsonBody = null;
    if ($rawBody !== '' && json_validate($rawBody)) {
        $jsonBody = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    }

    return [
        'received_at' => $received->format('Y-m-d\TH:i:s'),
        'unix' => (int) $received->format('U'),
        'microseconds' => (int) $received->format('u'),
        'method' => $_SERVER['REQUEST_METHOD'] ?? '',
        'protocol' => $_SERVER['SERVER_PROTOCOL'] ?? '',
        'content_type' => $_SERVER['CONTENT_TYPE'] ?? '',
        'content_length' => $_SERVER['CONTENT_LENGTH'] ?? '',
        'host' => $_SERVER['HTTP_HOST'] ?? '',
        'request_uri' => $_SERVER['REQUEST_URI'] ?? '',
        'query_string' => $_SERVER['QUERY_STRING'] ?? '',
        'script_name' => $_SERVER['SCRIPT_NAME'] ?? '',
        'path_info' => $_SERVER['PATH_INFO'] ?? '',
        'remote_addr' => $_SERVER['REMOTE_ADDR'] ?? '',
        'remote_port' => $_SERVER['REMOTE_PORT'] ?? '',
        'headers' => collectHeaders(),
        'get' => $_GET,
        'post' => $_POST,
        'cookie' => $_COOKIE,
        'files' => collectFileMetadata(),
        'raw_body' => $rawBody,
        'json_body' => $jsonBody,
    ];
}

/**
 * Returns all HTTP request headers.
 *
 * @return array<string, string>
 */
function collectHeaders(): array
{
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            $normalized = [];
            foreach ($headers as $name => $value) {
                $normalized[(string) $name] = (string) $value;
            }

            return $normalized;
        }
    }

    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (!str_starts_with($key, 'HTTP_')) {
            continue;
        }

        $name = strtolower(substr($key, 5));
        $name = str_replace(' ', '-', ucwords(str_replace('_', ' ', $name)));
        $headers[$name] = (string) $value;
    }

    return $headers;
}

/**
 * Returns uploaded-file metadata without storing file bytes.
 *
 * @return array<string, array<string, mixed>>
 */
function collectFileMetadata(): array
{
    $files = [];
    foreach ($_FILES as $field => $info) {
        if (!is_array($info)) {
            continue;
        }

        $files[$field] = [
            'name' => $info['name'] ?? '',
            'type' => $info['type'] ?? '',
            'size' => $info['size'] ?? 0,
            'error' => $info['error'] ?? 0,
        ];
    }

    return $files;
}
