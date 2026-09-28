<?php

declare(strict_types=1);

/**
 * Application configuration template.
 *
 * Copy this file to config.php (next to htdocs/, outside the webroot) and
 * fill in your own values. Tokens must be at least 6 characters. Store keys
 * must be exactly 16 alphanumeric characters.
 *
 * !!! WARNING: the token and store_key in the tokens array below are EXAMPLE
 * values only. They are made up, public, and committed to this repository.
 * Replace them before deploying - anyone keeping the example values can read,
 * delete, and impersonate your notes.
 */
return [
    // debug.php writes request dumps while this is true; set false in prod.
    'debug_capture' => false,
    'timezone' => 'Europe/Berlin',
    'gc' => [
        'log_days' => 7,           // delete log/YYYYMMDD.log older than this
        'synced_note_days' => 30,  // delete synced notes older than this
    ],
    // Optional: title notes with a local Ollama model instead of the timestamp
    // title ("Note Ring Fri 21 Aug 13:25"). Pebble sends no title, so this
    // applies to every saved note while enabled.
    //
    // When the model answers, its title is stored; if Ollama is down, slow, or
    // returns something unusable, the timestamp title is used and the note is
    // saved either way. Requires php-curl and a model pulled into Ollama.
    //
    // The values below are a working localhost setup - set 'enabled' to true.
    'ollama' => [
        'enabled' => false,
        'url' => 'http://127.0.0.1:11434/api/chat',
        'model' => 'qwen3:1.7b',
        'timeout_seconds' => 30,       // warm model: thinking is off, titles are quick
        'cold_timeout_seconds' => 120, // model not loaded yet: allow the load to finish
        'keep_alive' => '10m',         // keeps the model warm between memos
        'options' => [
            'temperature' => 0.3,
            'num_ctx' => 2048,
            'num_predict' => 48,       // titles are short; cap the generation
        ],
    ],
    'tokens' => [
        // !!! CHANGE THESE !!! Example values below are public - never deploy them.
        // Generate your own token (>= 6 chars) and a random 16-char alnum store_key.
        '1234567890SAMPLE123456789' => [
            'store_key' => 'demo12345678',
            'devicename' => 'Ring',
            // Opt this token in to Ollama titles (needs ollama.enabled above);
            // set false to keep this token on timestamp titles.
            'ollama' => true,
        ],
    ],
];

