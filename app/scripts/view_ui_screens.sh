#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
GOLDEN_DIR="$APP_DIR/test/goldens"
OUTPUT_DIR="$APP_DIR/build/ui-screen-gallery"
OUTPUT_FILE="$OUTPUT_DIR/index.html"

group=""
include_qa=false
delay_seconds=3
open_gallery=true

usage() {
  cat <<'USAGE'
View the captured Draught Bet Flutter screens as a browser slideshow.

Usage:
  ./scripts/view_ui_screens.sh [options]

Options:
  --group NAME       Show one golden folder, for example home_flow.
  --include-qa       Include QA comparison images.
  --delay SECONDS    Automatic slide delay. Use 0 for manual navigation.
  --no-open          Generate the gallery without opening the browser.
  --list-groups      Print the available screen groups and exit.
  -h, --help         Show this help.

Controls in the gallery:
  Left/Right arrows  Previous/next screen
  Space              Pause/resume automatic playback
  Home/End           First/last screen
USAGE
}

while (($# > 0)); do
  case "$1" in
    --group)
      [[ $# -ge 2 ]] || { echo "--group requires a folder name." >&2; exit 2; }
      group="$2"
      shift 2
      ;;
    --include-qa)
      include_qa=true
      shift
      ;;
    --delay)
      [[ $# -ge 2 ]] || { echo "--delay requires a number." >&2; exit 2; }
      delay_seconds="$2"
      shift 2
      ;;
    --no-open)
      open_gallery=false
      shift
      ;;
    --list-groups)
      find "$GOLDEN_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$delay_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  echo "--delay must be zero or a positive number." >&2
  exit 2
}

scan_dir="$GOLDEN_DIR"
if [[ -n "$group" ]]; then
  scan_dir="$GOLDEN_DIR/$group"
  [[ -d "$scan_dir" ]] || {
    echo "Unknown screen group: $group" >&2
    echo "Run with --list-groups to see the available groups." >&2
    exit 2
  }
fi

find_args=(
  "$scan_dir"
  -type f
  \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \)
  ! -path '*/failures/*'
)

if [[ "$include_qa" == false ]]; then
  find_args+=( ! -path '*/goldens/*_qa/*' )
fi

mapfile -d '' screens < <(find "${find_args[@]}" -print0 | sort -zV)

if ((${#screens[@]} == 0)); then
  echo "No captured UI screens were found in $scan_dir" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

{
  cat <<'HTML_HEAD'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Draught Bet UI Screen Gallery</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #000;
      color: #f5f7fa;
      font-family: Inter, system-ui, sans-serif;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header, footer {
      background: #07111f;
      border-color: #183047;
      border-style: solid;
      padding: 12px 18px;
    }
    header { border-width: 0 0 1px; }
    footer { border-width: 1px 0 0; }
    .heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 17px; }
    #counter { color: #f5c451; font-weight: 700; white-space: nowrap; }
    #title { margin-top: 5px; color: #8fa3b7; font-size: 13px; text-transform: capitalize; }
    main { min-height: 0; display: grid; place-items: center; padding: 18px; overflow: hidden; }
    img { max-width: 100%; max-height: calc(100vh - 155px); object-fit: contain; border-radius: 14px; }
    .controls { display: flex; justify-content: center; align-items: center; gap: 10px; }
    button {
      min-width: 112px;
      min-height: 44px;
      border: 1px solid #26e6a4;
      border-radius: 10px;
      background: #0c1b2a;
      color: #f5f7fa;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover, button:focus-visible { background: #183047; outline: 2px solid #26e6a4; }
    #play { border-color: #f5c451; }
    @media (max-width: 560px) {
      header, footer { padding: 10px; }
      main { padding: 8px; }
      button { min-width: 86px; }
      img { max-height: calc(100vh - 145px); }
    }
  </style>
</head>
<body>
  <header>
    <div class="heading">
      <h1>Draught Bet UI Screens</h1>
      <span id="counter"></span>
    </div>
    <div id="title"></div>
  </header>
  <main><img id="screen" alt="Draught Bet UI screen"></main>
  <footer>
    <div class="controls">
      <button id="previous" type="button">← Previous</button>
      <button id="play" type="button">Pause</button>
      <button id="next" type="button">Next →</button>
    </div>
  </footer>
  <script>
    const screens = [
HTML_HEAD

  for index in "${!screens[@]}"; do
    path="$(realpath -- "${screens[$index]}")"
    relative="${path#"$GOLDEN_DIR"/}"
    screen_group="${relative%%/*}"
    filename="${relative##*/}"
    filename="${filename%.*}"
    label="${screen_group//_/ } — ${filename//_/ }"
    comma=','
    if ((index == ${#screens[@]} - 1)); then comma=''; fi
    printf '      { src: "file://%s", title: "%s" }%s\n' "$path" "$label" "$comma"
  done

  cat <<HTML_TAIL
    ];
    const delayMs = Number(${delay_seconds}) * 1000;
    const image = document.querySelector('#screen');
    const title = document.querySelector('#title');
    const counter = document.querySelector('#counter');
    const playButton = document.querySelector('#play');
    let current = 0;
    let playing = delayMs > 0;
    let timer;

    function render() {
      const item = screens[current];
      image.src = item.src;
      image.alt = item.title;
      title.textContent = item.title;
      counter.textContent = \`\${current + 1} / \${screens.length}\`;
      playButton.textContent = playing ? 'Pause' : 'Play';
      clearTimeout(timer);
      if (playing) timer = setTimeout(() => show(current + 1), delayMs);
    }

    function show(index) {
      current = (index + screens.length) % screens.length;
      render();
    }

    function togglePlayback() {
      if (delayMs === 0) return;
      playing = !playing;
      render();
    }

    document.querySelector('#previous').addEventListener('click', () => show(current - 1));
    document.querySelector('#next').addEventListener('click', () => show(current + 1));
    playButton.addEventListener('click', togglePlayback);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') show(current - 1);
      if (event.key === 'ArrowRight') show(current + 1);
      if (event.key === 'Home') show(0);
      if (event.key === 'End') show(screens.length - 1);
      if (event.key === ' ') { event.preventDefault(); togglePlayback(); }
    });
    render();
  </script>
</body>
</html>
HTML_TAIL
} > "$OUTPUT_FILE"

echo "Generated gallery with ${#screens[@]} screens:"
echo "$OUTPUT_FILE"
echo "Use Left/Right, Home/End, or Space in the gallery."

if [[ "$open_gallery" == true ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$OUTPUT_FILE" >/dev/null 2>&1 &
  else
    echo "xdg-open is unavailable; open the HTML file above in your browser." >&2
  fi
fi
