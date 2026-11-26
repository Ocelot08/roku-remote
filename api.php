<?php
// Roku Remote shared state API — stores devices, apps, and Home Assistant
// settings server-side so every phone reads and writes the same data,
// instead of each phone keeping its own separate local copy.

header('Content-Type: application/json');

// The data file lives OUTSIDE the publicly served document root (one level
// up, in a sibling folder) so it can never be fetched directly over HTTP —
// only this script can reach it. It holds your Home Assistant access token,
// so this matters.
$dataDir = dirname(__DIR__) . '/roku-remote-data';
$dataFile = $dataDir . '/state.json';

function defaultState() {
  return [
    'devices' => [],
    'activeDeviceId' => null,
    'apps' => [
      ['name' => 'Netflix', 'id' => '12'],
      ['name' => 'YouTube', 'id' => '837'],
      ['name' => 'Prime Video', 'id' => '13'],
      ['name' => 'Hulu', 'id' => '2285'],
      ['name' => 'Peacock', 'id' => '593099'],
      ['name' => 'HBO Max', 'id' => '61322'],
      ['name' => 'Shudder', 'id' => '59997'],
      ['name' => 'Crunchyroll', 'id' => '2595'],
    ],
    'ha' => ['url' => '', 'token' => '', 'entity' => ''],
  ];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
  if (file_exists($dataFile)) {
    $contents = file_get_contents($dataFile);
    // Guard against a previously corrupted/empty file.
    if ($contents !== false && json_decode($contents) !== null) {
      echo $contents;
      exit;
    }
  }
  echo json_encode(defaultState());
  exit;
}

if ($method === 'POST') {
  $body = file_get_contents('php://input');
  $decoded = json_decode($body, true);
  if ($decoded === null) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid JSON']);
    exit;
  }

  if (!is_dir($dataDir)) {
    if (!mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
      http_response_code(500);
      echo json_encode(['error' => 'could not create data directory']);
      exit;
    }
  }

  $fp = fopen($dataFile, 'c+');
  if (!$fp) {
    http_response_code(500);
    echo json_encode(['error' => 'could not open data file for writing']);
    exit;
  }
  flock($fp, LOCK_EX);
  ftruncate($fp, 0);
  rewind($fp);
  fwrite($fp, json_encode($decoded, JSON_PRETTY_PRINT));
  fflush($fp);
  flock($fp, LOCK_UN);
  fclose($fp);

  echo json_encode(['ok' => true]);
  exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
