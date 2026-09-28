<?php

declare(strict_types=1);

/**
 * Optional note-title generation via a local Ollama instance. No Composer.
 *
 * Requires php-curl and a reachable Ollama (127.0.0.1:11434) with the model
 * pulled. Talks to /api/chat with thinking disabled: for short titles the
 * model's reasoning trace turns a few seconds into over a minute of noise.
 *
 * Every failure throws, so the caller can fall back to the timestamp title and
 * still store the note. Enable via the `ollama` block in config.php.
 */

const OLLAMA_TITLE_SYSTEM = <<<'PROMPT'
You write note titles for spoken memo transcripts.

INPUT
- German and/or English
- TTS/ASR: fillers (äh, also, halt), wrong splits, near-homophones
- Short messy monologue, not a clean document

RULES
1. Drop fillers. Fix only obvious ASR using context (e.g. "N Zynk" → "N-Sync", "Openmouse" stays if it looks like a name).
2. Find the one payload: who/what + action or topic. Ignore preamble ("Idee ist es", "eine andere Idee noch").
3. Prefer proper nouns from the note (products, people, firms, places, months, years).
4. Title language follows the note. Mixing DE/EN is fine if the note mixes.
5. Style target (match these, do not copy them unless they fit):
   PEKING 26
   Software to check
   Steuerberater TODO
   Lufthansa Fall Oktober
   Check Openmouse
   To buy on Amazon
6. 2–6 words. No sentence. No quotes. No trailing period.
   Ban: der die das ein eine und oder the a an I we my me dass weil.
   Keep: TODO, Check, Fall, names, months, years.
7. Do not invent facts that are not in the note.

OUTPUT
Valid JSON and nothing else. No markdown. No extra keys.
{"title":"<title>"}

Examples:
NOTE: Muss noch die Unterlagen für den Steuerberater zusammenpacken, vor allem die Belege von März.
{"title":"Steuerberater Belege März"}

NOTE: Check later if Openmouse still builds on the laptop after the kernel update.
{"title":"Check Openmouse"}

NOTE: Idee ist es für Juna, äh, also Hermes Agent, einen Skill zu schreiben, der den N-Sync Solaris APN. Um mir damit auch Nodes auf meinen Desktop bzw. Obsidian pushen zu können.
{"title":"Hermes Skill N-Sync"}

NOTE: Eine andere Idee noch für N Zynk, dass ich dort mal die Mistral-API einbaue, um mir mit dem leichten Mistral-Modell einfach eine Überschrift generieren zu lassen für die Notizen, die ich hier einspreche, damit direkt auch ein Title gesetzt wird, falls vom Ring, also vom Index API, kein Title übermittelt wird, was aktuell ist.
{"title":"N-Sync Mistral Titel"}
PROMPT;

const OLLAMA_TITLE_MAX_CHARS = 120;

/**
 * Default connection settings for a local Ollama instance.
 *
 * @return array{url: string, model: string, timeout_seconds: int, cold_timeout_seconds: int, keep_alive: string, options: array<string, int|float>}
 */
function ollamaDefaults(): array
{
    return [
        'url' => 'http://127.0.0.1:11434/api/chat',
        'model' => 'qwen3:1.7b',
        'timeout_seconds' => 30,        // warm model; thinking off makes titles quick
        'cold_timeout_seconds' => 120,  // model not loaded yet: allow the load to finish
        'keep_alive' => '10m',          // keeps the model warm across memo bursts
        'options' => [
            'temperature' => 0.3,
            'num_ctx' => 2048,
            'num_predict' => 48,
        ],
    ];
}

/**
 * Asks the configured Ollama model for a title for $note.
 *
 * Checks first whether the model is loaded: a warm model answers within
 * timeout_seconds, while a cold one has to be read from disk and gets
 * cold_timeout_seconds instead.
 *
 * @param array{url: string, model: string, timeout_seconds: int, cold_timeout_seconds: int, keep_alive: string, options: array<string, int|float>} $config
 *
 * @throws InvalidArgumentException when the note is empty
 * @throws RuntimeException when php-curl is missing, Ollama is unreachable,
 *                          or the reply has no usable title
 */
function ollamaNoteTitle(string $note, array $config): string
{
    $note = trim($note);
    if ($note === '') {
        throw new InvalidArgumentException('empty note');
    }
    if (!function_exists('curl_init')) {
        throw new RuntimeException('php-curl missing');
    }

    $warm = ollamaModelWarm($config);
    $timeout = $warm
        ? (int) ($config['timeout_seconds'] ?? 30)
        : (int) ($config['cold_timeout_seconds'] ?? ($config['timeout_seconds'] ?? 30));

    $payload = [
        'model' => $config['model'],
        // Thinking stays off: a title does not need a reasoning trace, and it
        // multiplies latency. Never combine this with a JSON format request.
        'think' => false,
        'stream' => false,
        'keep_alive' => $config['keep_alive'],
        'options' => $config['options'],
        'messages' => [
            ['role' => 'system', 'content' => OLLAMA_TITLE_SYSTEM],
            ['role' => 'user', 'content' => "NOTE:\n" . $note],
        ],
    ];

    $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($encoded === false) {
        throw new RuntimeException('could not encode request');
    }

    $ch = curl_init($config['url']);
    if ($ch === false) {
        throw new RuntimeException('curl init failed');
    }

    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => $encoded,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => max(1, $timeout),
    ]);
    $raw = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false) {
        throw new RuntimeException('ollama unreachable: ' . $error);
    }
    if ($status !== 200) {
        throw new RuntimeException('ollama HTTP ' . $status . ': ' . substr((string) $raw, 0, 500));
    }

    $response = json_decode((string) $raw, true);
    if (!is_array($response)) {
        throw new RuntimeException('ollama returned a non-JSON envelope');
    }

    $title = ollamaParseTitle((string) ($response['message']['content'] ?? ''));
    if ($title === '') {
        throw new RuntimeException('ollama returned no usable title');
    }

    return $title;
}

/**
 * Returns true when the configured model is already loaded in memory. A false
 * result means the next chat call may have to load the model from disk, which
 * can take far longer than a warm request.
 *
 * @param array{url: string, model: string} $config
 *
 * @throws RuntimeException when Ollama cannot be reached at all
 */
function ollamaModelWarm(array $config): bool
{
    $psUrl = ollamaPsUrl((string) $config['url']);
    if ($psUrl === null || !function_exists('curl_init')) {
        return false;
    }

    $ch = curl_init($psUrl);
    if ($ch === false) {
        return false;
    }

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 3,
    ]);
    $raw = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false) {
        // No point waiting for a chat call that will fail the same way.
        throw new RuntimeException('ollama unreachable: ' . $error);
    }
    if ($status !== 200) {
        // Older builds without /api/ps: assume cold and allow the longer load.
        return false;
    }

    $response = json_decode((string) $raw, true);
    if (!is_array($response) || !is_array($response['models'] ?? null)) {
        return false;
    }

    foreach ($response['models'] as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        foreach (['name', 'model'] as $key) {
            $loaded = is_string($entry[$key] ?? null) ? $entry[$key] : '';
            if ($loaded !== '' && ollamaSameModel((string) $config['model'], $loaded)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Maps the chat endpoint to the loaded-models endpoint. Returns null when the
 * URL does not look like /api/chat, in which case the caller treats the model
 * as cold.
 */
function ollamaPsUrl(string $chatUrl): ?string
{
    $suffix = '/api/chat';
    if (!str_ends_with($chatUrl, $suffix)) {
        return null;
    }

    return substr($chatUrl, 0, -strlen($suffix)) . '/api/ps';
}

/**
 * Compares a configured model name with one reported as loaded, treating a
 * missing tag as :latest ("qwen3" == "qwen3:latest").
 */
function ollamaSameModel(string $configured, string $loaded): bool
{
    $normalize = static function (string $name): string {
        $name = strtolower($name);
        return str_ends_with($name, ':latest') ? substr($name, 0, -strlen(':latest')) : $name;
    };

    return $normalize($configured) === $normalize($loaded);
}

/**
 * Extracts the title from a model reply that should be {"title":"..."}.
 * Tolerates markdown fences and surrounding prose before giving up.
 */
function ollamaParseTitle(string $content): string
{
    $content = trim($content);
    if ($content === '') {
        return '';
    }

    $stripped = preg_replace('/^```(?:json)?\s*|\s*```$/', '', $content);
    if (is_string($stripped)) {
        $content = $stripped;
    }

    $decoded = json_decode($content, true);
    if (!is_array($decoded) && preg_match('/\{.*\}/s', $content, $match) === 1) {
        $decoded = json_decode($match[0], true);
    }

    $title = is_array($decoded) ? ($decoded['title'] ?? '') : '';
    if (!is_string($title)) {
        return '';
    }

    return ollamaSanitizeTitle($title);
}

/**
 * Makes a supplied title (model- or client-provided) safe for a single-line
 * quoted YAML scalar: rejects invalid UTF-8, collapses control characters and
 * whitespace, trims wrapping quotes and a trailing period, and caps the length.
 */
function ollamaSanitizeTitle(string $title): string
{
    // Drop line breaks before the UTF-8 check so a failed regex cannot keep them.
    $title = str_replace(["\r\n", "\r", "\n", "\t", "\0"], ' ', $title);
    if (preg_match('//u', $title) !== 1) {
        return '';
    }

    $clean = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $title);
    if (!is_string($clean)) {
        return '';
    }
    $title = $clean;

    $collapsed = preg_replace('/\s+/u', ' ', $title);
    if (!is_string($collapsed)) {
        return '';
    }
    $title = trim($collapsed);
    $title = trim($title, "\"'“”");
    $title = rtrim($title, '.');
    $title = trim($title);

    if (function_exists('mb_substr')) {
        return mb_substr($title, 0, OLLAMA_TITLE_MAX_CHARS, 'UTF-8');
    }

    return substr($title, 0, OLLAMA_TITLE_MAX_CHARS);
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === realpath(__FILE__)) {
    $argv1 = $argv[1] ?? '';
    $text = is_string($argv1) ? $argv1 : '';
    if ($text === '' || $text === '-') {
        $stdin = stream_get_contents(STDIN);
        $text = is_string($stdin) ? $stdin : '';
    }

    try {
        fwrite(STDOUT, ollamaNoteTitle($text, ollamaDefaults()) . PHP_EOL);
    } catch (Throwable $e) {
        fwrite(STDERR, $e->getMessage() . PHP_EOL);
        exit(1);
    }
}
