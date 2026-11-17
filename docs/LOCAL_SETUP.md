# Local Hermes desktops and voice choices

This fork adds `COMPUTER_BACKEND=hermes`: every Bot HQ bot gets a Hermes home,
gateway, browser profile and virtual Xfce desktop on your Linux PC. Hermes
owns the desktops; Bot HQ relays their private Unix RFB sockets to the existing
authenticated viewer. No Orgo account, computer ID, API key or cloud desktop fee
is needed. These are separate screens under your Linux user, not separate VMs
or a filesystem isolation boundary.

By default, **every local bot is managed by Bot HQ**, including its first bot.
The existing Hermes home supplies the initial model settings and sign-in, but
its configuration and running gateway are left alone. This also works when
your personal Hermes agent uses Docker: the new bots explicitly use local
terminals and local desktops. Files created by a bot appear in `data/files/<botId>`.

## Prepare and run

Requires Linux, Node 22+, Python and an installed Hermes version with
`tools.bot_desktop` (check `hermes computer-use screen --help`).

1. Install the local desktop and input driver through Hermes, once:

   ```bash
   hermes computer-use screen install
   hermes computer-use install
   ```

   The first command installs TigerVNC/Xfce packages through your distribution's
   package manager and may ask for sudo. It does not create a cloud computer.
   Install a Chromium browser too; Hermes uses its own supported browser setup
   or a system Chromium/Google Chrome binary for the desktop's browser.

2. In this checkout:

   ```bash
   npm ci
   node scripts/setup-local.mjs
   npm run build
   npm start
   ```

   Open **http://localhost:8787** and use the local email sign-in. The setup
   script creates a private `.env` with a random session secret. It refuses to
   replace an existing `.env`. Paid-service keys can stay empty. The server
   binds to `127.0.0.1` by default. `DEV_LOGIN=1` is intended for local use.

3. Open a bot's computer viewer. Its screen starts on demand. **Take control**
   acquires Hermes' human lease, which pauses Hermes browser/computer tools;
   closing the viewer hands control back. A second controller evicts the first.
   Watch-only connections have input filtered server-side. Shell commands run
   by an agent are outside that tool-level lease.

The bot engine inherits model settings and credentials from `~/.hermes` on its
first start. Change models/sign-in in Bot HQ's Engine panel. Model providers
and connected third-party services can still have their own usage charges.

For source installs outside the usual directory, set:

```dotenv
HERMES_SOURCE_DIR=/absolute/path/to/hermes-agent
HERMES_PYTHON=/absolute/path/to/hermes/python
```

`HERMES_PYTHON` can be omitted with recent managed Hermes launchers, which
expose `hermes --print-runtime-command`. Use Hermes' actual Python rather than
an unrelated system interpreter, so its dependencies and bootstrap agree.

For development, run `npm run dev -w server` and `npm run dev -w web` in separate
terminals, then use http://localhost:5173. The production build needs no Vite
server. Stopping Bot HQ leaves its managed Hermes gateways running, matching
upstream behavior. Deleting a managed bot stops its desktop and gateway before
removing its home. Reset restarts that bot's desktop and closes its open apps.

### Optional: attach the existing Hermes agent

Set `USE_PRIMARY_ENGINE=1` **before creating the first bot** only if you want
that bot to be your existing Hermes agent. Existing bots are not migrated by
this setting. This is an advanced option: that primary home needs a local
terminal backend, a local headed browser, and `computer_use` enabled for its
`api_server` toolset. Its API server and Bot HQ MCP entry also need configuring
as described in the upstream README. Bot HQ does not rewrite the primary
home or restart that gateway. Starting its Bot Desktop changes where that
profile's computer/browser tools operate, including its other channels.

## xAI voice: keep the existing implementation

1. Create an API key and configure API billing at [the xAI console](https://console.x.ai/).
2. Add to the checkout's `.env`:

   ```dotenv
   XAI_API_KEY=your-api-key
   XAI_VOICE_MODEL=grok-voice-latest
   XAI_STT_MODEL=grok-voice-transcribe-2.0
   ```

3. Restart Bot HQ, open a bot and start a voice call. Allow microphone access.
   Localhost works for microphone permissions; remote access needs HTTPS.

The API key stays on the server. Bot HQ obtains an ephemeral client secret
and the browser connects to xAI's realtime WebSocket. Voice tasks are handed
to the same Hermes bot. The same key also enables research on X. Voice uses
separate API billing from the Hermes bot's model access.

As checked on 2026-11-16, the official model page lists speech-to-speech at
**US$0.08/minute** (US$4.80 for 60 billed minutes), standalone TTS at
US$15/million characters, and batch STT at US$0.10/hour. Hermes task model
usage, X search, and the app's xAI call summaries can add separate charges.
Check [current pricing](https://docs.x.ai/developers/models) before use.

## Open-source voice alternative: design, not yet implemented

A practical local pipeline is:

```text
Microphone → faster-whisper (transcription) → existing Hermes bot
           → text response → Kokoro (speech synthesis) → speakers
```

| Option | Runs | Cost | Behavior and integration |
| --- | --- | --- | --- |
| Existing xAI voice | Hosted | Metered API usage | Already wired into Bot HQ; streaming conversation, turn detection, interruptions and tool handoff. Audio goes to xAI. |
| faster-whisper + Kokoro + Hermes | Local speech models; Hermes model of your choice | No speech API fee; hardware/electricity and any hosted Hermes model still cost | Local speech processing. Start with push-to-talk, then add voice activity detection and interruption handling. Requires a new local call adapter. |

[faster-whisper](https://github.com/SYSTRAN/faster-whisper) is an MIT-licensed
Whisper implementation with CPU INT8 and GPU options. Start with CPU INT8 on
older GPUs unless the CUDA/CTranslate2 versions are confirmed compatible.
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is a small TTS model with
Apache-licensed weights and multiple voices. Both can run locally after model
downloads. Voice and language quality should be checked with your own audio.

This is **not a drop-in realtime endpoint replacement**. The existing browser
call code (`web/src/voice/call.ts`) expects xAI session events and function
calls. A local implementation needs microphone upload/streaming, a local STT
service, speech playback, and an adapter that submits requests to the existing
Hermes chat and reads its responses. Call summaries must also stop calling
xAI if you want the whole voice path independent of xAI. Native Hermes TTS
settings alone do not rewire Bot HQ's voice UI.

Voice is intentionally unchanged in this branch. If `XAI_API_KEY` is blank,
voice endpoints return a configuration message while local chat/desktops
continue to work. Composio app connections are separately optional through
`COMPOSIO_API_KEY`.

## Verification

```bash
npm run typecheck
npm run build
node --test tests/local-desktop.test.mjs
```

The integration test uses a real Bot HQ server, SQLite, authentication,
Python bridge and Unix RFB connection with a simulated Hermes runtime. It
checks startup without paid keys, local Library access, watch input filtering,
control handback and takeover by another viewer. It does not validate real
Xfce rendering, model work or paid voice calls. Test those after installing
the desktop prerequisites. This adapter uses Hermes' internal Bot Desktop
Python API; changes to that API can require an adapter update.
