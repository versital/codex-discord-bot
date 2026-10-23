# Codex Discord Bot

A Discord bot that answers anyone who @mentions it (or uses `/ask`) by running OpenAI's Codex CLI
in a read-only sandbox. Everyone gets their own chats it remembers, their own model, effort and
personality settings, and it reads photos, files, PDFs, zips and videos. Runs on Rocky Linux and
Windows 10/11, and updates itself from this repo with `/admin update`.

## 1. Create the Discord bot (any PC, in a browser)

1. Go to https://discord.com/developers/applications, then **New Application**. Name it `Codex`.
2. **Bot** tab: click **Reset Token** and copy the token. Turn on **Message Content Intent**.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`; permissions: View Channels,
   Send Messages, Send Messages in Threads, Read Message History, Attach Files.
   Open the generated URL and add the bot to your server.

Then follow **2A** for Rocky Linux or **2B** for Windows. Run the bot on only one machine at a time,
or both will answer every ping.

## 2A. Rocky Linux

```bash
git clone https://github.com/versital/codex-discord-bot.git
cd codex-discord-bot
sudo ./install.sh
```

(Or copy the folder over from a zip; then run `sed -i 's/\r$//' install.sh && chmod +x install.sh` first.)

This installs Node.js, the Codex CLI and the file tools, creates a locked-down `codexbot` user and a
systemd service. On a first install, log in and add your token:

```bash
# ChatGPT account (shows a code to enter in any browser):
sudo -u codexbot -H codex login --device-auth
# ...or with an OpenAI API key:
sudo -u codexbot -H sh -c 'read -rsp "API key: " K; echo; printf %s "$K" | codex login --with-api-key'

sudo nano /etc/codex-discord-bot.env     # set DISCORD_TOKEN=...
sudo systemctl enable --now codex-discord-bot
journalctl -u codex-discord-bot -f       # should print "Logged in as Codex#1234"
```

## 2B. Windows 10 / 11

Download the repo (green **Code** button → *Download ZIP*, or `git clone`), extract it, then open
**PowerShell as administrator** in that folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

It asks for a Codex login (ChatGPT device code, or an API key) and your Discord bot token, then:

- installs Node.js, ffmpeg and Poppler with `winget` if they're missing (`-SkipFfmpeg` / `-SkipPoppler`)
- creates a hidden, standard (non-admin) Windows account `codexbot` that the bot runs as, so Codex
  can't see your own files
- checks Codex's sandbox really blocks writes for that account, and refuses to start if not
- registers a background task that starts the bot with Windows, even before anyone signs in

```powershell
Get-Content C:\ProgramData\CodexDiscordBot\bot.log -Tail 50 -Wait       # logs
notepad C:\ProgramData\CodexDiscordBot\bot.env                           # settings
Stop-ScheduledTask CodexDiscordBot; Start-ScheduledTask CodexDiscordBot  # restart
```

To remove everything, run `.\uninstall-windows.ps1` the same way.

## Using it

Ping it: `@Codex what's the difference between TCP and UDP?`, or use `/ask`. While it works you
see live progress and a **Stop** button; answers come with **Retry** and **New chat** buttons.

**Chats.** Each person has their own chat per server, so follow-ups just work. A chat ends after
2 hours of silence (a new one starts automatically), or when you use `/new`. Replying to one of
the bot's answers (with ping on) continues *that* chat.

| Command | What it does |
|---|---|
| `/ask` | Ask with an optional file; `private` shows the answer only to you; `new_chat` starts fresh |
| `/new` | Start a new chat (old ones stay in `/chats`) |
| `/chats` | List your chats and switch with a menu |
| `/resume` | Switch back to an earlier chat |
| `/export` | Download a chat as a Markdown file |
| `/retry` | Ask your last message again |
| `/stop` | Stop your running request |
| `/model` | Show the available models or pick one |
| `/effort` | low / medium / high / xhigh: how hard it thinks (lower is faster) |
| `/thinking` | Show or hide a summary of its thinking above answers |
| `/length` | short / normal / long answers |
| `/fast` | Fast mode: about 2x quicker, uses more quota |
| `/personality` | `set` your own style, pick a `preset`, `show` or `clear` it |
| `/settings` | Show your settings |
| `/reset` | Reset your settings (keeps chats) |
| `/usage` | Your requests and tokens |
| `/forget` | Delete your chats, settings and usage |
| `/help` | Quick help |
| `/admin` | Owner only: `status`, `update`, `rollback`, `restart` |

Settings are per person. New slash commands can take a minute to appear in Discord.

**Speed tips.** Most of the wait is the model thinking. `/effort low` (the default), `/fast on`
and a smaller `/model` are the biggest wins.

## Attachments

Attach files to the message where you ping it, or to the message you reply to.

| Type | What Codex gets |
|---|---|
| Photos (png, jpg, webp) | The image itself |
| Other images (bmp, tiff...) | Converted to PNG (needs ffmpeg) |
| Text / code / logs / csv / json... | The file, which it reads with shell tools |
| PDF | Extracted text; scanned PDFs send the first 4 pages as images |
| Zip | Unpacked so it can browse the contents (size-capped) |
| Video / GIF | 6 evenly spaced still frames, no audio (needs ffmpeg) |
| Audio | Not supported |

On Linux, ffmpeg comes from EPEL + RPM Fusion; `SKIP_FFMPEG=1 sudo ./install.sh` skips it.

## Updating

Run **`/admin update`** in Discord. The bot downloads the latest version from GitHub, installs it
next to the current one, checks it loads, restarts into it and DMs you when it's back.
`/admin update check_only:true` just checks, `/admin update zip:<file>` installs an uploaded zip,
and `/admin rollback` switches back to the previous version. If a new version keeps crashing
before it connects, the bot switches back by itself.

The bot also checks GitHub every 6 hours and DMs the owner when there's an update
(`AUTO_UPDATE=true` installs it automatically instead).

Only the bot's owner (the Discord account that owns the application) and `ADMIN_USER_IDS` can use
`/admin`. Re-running the installer is only needed for changes to the installer or launcher; it
keeps your settings, chats and installed version.

Linux fallback without Discord:
`sudo -u codexbot -H env DATA_DIR=/var/lib/codexbot node /opt/codex-discord-bot/launcher.js update && sudo systemctl restart codex-discord-bot`

## Safety notes

Anyone who can ping the bot is effectively typing into an AI agent on your PC, so:

- Codex runs with a read-only sandbox, as the unprivileged `codexbot` user. Its commands can't
  write files or reach the network. On Windows the sandbox also can't read the settings folder
  that holds the token.
- The Discord token is kept out of Codex's environment and redacted from replies, along with
  anything that looks like an API key. Replies can never ping @everyone, roles or users.
- Per-user cooldown, one running request per person, a queue limit, a 3-minute timeout and an
  optional daily limit.
- Every request uses your Codex/ChatGPT quota or API credits. To limit who can use it, set
  `ALLOWED_GUILD_IDS` / `ALLOWED_USER_IDS`, or `DAILY_REQUEST_LIMIT`.

Read-only still means Codex can *read* files the `codexbot` user can read. Don't put anything
private in `/var/lib/codexbot`. On Windows your own user folder is private by default, but other
drives (like `D:\`) are often readable by every account.

## Settings

In `/etc/codex-discord-bot.env` (Linux) or `C:\ProgramData\CodexDiscordBot\bot.env` (Windows).
Restart the bot after changing them. All options are described in `.env.example`; the main ones:

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token |
| `DEFAULT_MODEL` / `DEFAULT_EFFORT` | Codex default / low | Used until someone picks their own |
| `ALLOWED_MODELS` / `ALLOWED_EFFORTS` | all / low…xhigh | What `/model` and `/effort` allow |
| `ALLOW_FAST` | true | Allow `/fast` |
| `CHAT_IDLE_MINUTES` | 120 | Start a new chat after this much silence |
| `CHAT_RETENTION_DAYS` | 30 | Delete chats unused this long |
| `DAILY_REQUEST_LIMIT` | 0 (off) | Requests per person per day |
| `MAX_CONCURRENT` / `MAX_QUEUE` | 2 / 10 | Parallel runs / waiting requests |
| `ALLOWED_GUILD_IDS` / `ALLOWED_USER_IDS` | anyone | Allowlists |
| `ADMIN_USER_IDS` | owner only | Extra `/admin` users |
| `ALLOW_DMS` | false | Also answer DMs |
| `UPDATE_REPO` / `UPDATE_CHECK_HOURS` / `AUTO_UPDATE` | this repo / 6 / false | Updates |

## Troubleshooting

- **Bot is online but ignores pings**: Message Content Intent isn't on, or the bot can't see the channel.
- **No slash commands**: re-invite the bot with the `applications.commands` scope, then wait a minute.
- **"Something went wrong talking to Codex"**: check the logs. Usually Codex isn't logged in:
  `sudo -u codexbot -H codex login status` (Linux), or re-run the Windows installer.
- **"couldn't reopen your old chat"**: its saved session was cleaned up; a fresh chat was started.
- **Windows: bot never starts**: open Task Scheduler, find `CodexDiscordBot`, check *Last Run Result*,
  then `bot.log`. Re-running the installer resets the task.
