---
name: explain-in-video
description: Make a short narrated video (about 60 to 90 seconds) of a pull request or a piece of finished work. It shows the working result through screenshots and keeps code to a one-screen overview. Built into Agentic Crafting Table for Explain in video.
---

A narrated slideshow: each **moment** is one still frame held while one spoken line plays. One `storyboard.json` drives it, and one command builds it on this computer: Playwright renders the frames, Kokoro voices the lines, and ffmpeg stitches the MP4. Built on Matt Pocock's animatic pipeline (MIT, `LICENSE-animatic`, from mattpocock/skills).

In this file, `<skill>` is the folder that holds this SKILL.md. Its path can contain spaces, so always quote it in commands: `"<skill>/scripts/animatic.mjs"`.

## 0. Check the tools first

Nothing gets installed without the person's yes, and they are asked **once**, with everything listed together.

1. **Look.** Run `node --version` and `npm --version`, plus `brew --version` on macOS. When both `node` and `npm` work, run the check below; it installs nothing. When it prints `Ready`, go on to the rules.

   ```
   node "<skill>/scripts/animatic.mjs" check --engine kokoro
   ```

2. **Ask once.** List each item with its approximate size and where it goes:
   - When `node` or `npm` is missing, `check` cannot run, so list the worst case: Node.js with npm (about 100MB, system-wide, from nodejs.org or the system package manager), the Node packages (about 450MB, into `~/.cache/animatic`), Chromium for Playwright (about 550MB, into Playwright's cache), the voice model (about 90MB, into `~/.cache/animatic`) and ffmpeg (system-wide).
   - Otherwise, exactly what `check` listed.
   - On macOS, when ffmpeg is in the list and `brew` is missing: Homebrew (about 500MB with Apple's command line tools, system-wide, from brew.sh).
   - `setup` downloads from npm, Playwright and Hugging Face. If you run in a sandbox without network access, say so in the same question and request the permission or escalation with it.
3. **Wait for a yes.** Never install anything without it. Without a yes, stop and say the video was not made.
4. **After the yes:** install Node.js first when it was listed, then run `check`. If it lists anything that was not in the approved list, ask again before going on. Then install Homebrew and ffmpeg when listed, run `node "<skill>/scripts/animatic.mjs" setup --engine kokoro` (it installs exactly what `check` lists, nothing more), and run `check` again. Build only after it prints `Ready`: `build` never downloads anything.

## The rules

1. **Show the outcome, not the code.** At least half the run time is the working result, shown in real screenshots, one per step of the flow.
2. **Code is one overview screen at most.** Use one `diagram` (3 to 5 boxes in plain words: what the person sees, what stores it, what runs it) with Reveals, for 2 to 3 moments. Use no `code` frames unless the person asks for them. Never name functions, and never give line numbers.
3. **A screen recording becomes a run of screenshots.** The pipeline plays stills only. Capture one shot per step (the page, the click, the result) at the same viewport size, so consecutive shots read as motion. Each entry with an `"image"` counts as a Cut in the report. Shots of the same screen still read as Reveals, so ignore the Cut count for them.
4. **Local voice only:** `--engine kokoro --voice af_heart`. Never an online voice: the lines name private code and features.

Read `"<skill>/STYLE.md"` (the line and frame rules), `"<skill>/FRAMES.md"` (frame types) and `"<skill>/OWN-MEDIA.md"` (image entries) once before writing. Where they conflict with the rules above, the rules above win.

## 1. Gather

- **The work:** the pull request's title and body, or what this session set out to do and what it built, plus the latest test and lint output tails. Do not read the whole diff: `git diff --stat` and what you already know are enough.
- **The why** comes from the issue or the request, then the pull request body. The diff says what changed, never why.

## 2. Capture the outcome

Work in a new folder under the system temp folder (`$TMPDIR/explain-video-<repo>-<pr or slug>/`), never inside a repository. Save shots as `shots/NN-<step>.png`.

| Surface | How to capture |
|---|---|
| A local web UI | A Playwright screenshot at a 1440x900 viewport, or a short Playwright script. Local or staging only. |
| A desktop app on macOS | `screencapture -o -l <windowid> shots/NN.png` (window id via `osascript`), or the end-to-end tests' screenshots. |
| Android emulator | `adb exec-out screencap -p > shots/NN.png` |
| iOS simulator | `xcrun simctl io booted screenshot shots/NN.png` |
| Backend only, no UI | A `terminal` frame with the real request and response, or the real log line. Show the effect, never invent output. |

- Never open production systems or customer data for the video, and keep personal data off screen.
- **Look at every shot** before writing its line. A shot showing an error gets narrated as an error, and named at hand-over.
- If a step cannot be captured (no dev server running, no device), use a `diagram` frame for it and say so at hand-over. Do not start servers or emulators just for the video unless they are already running.

## 3. Write the storyboard

Target 60 to 90 seconds: 8 to 12 moments, 4 to 6 Cuts. The arc:

1. **Title:** a `title` frame with the pull request number or the task as the kicker, and a headline in plain words. (1 moment)
2. **Before:** the "before" screenshot, or a 3-box diagram of what hurt. Say who was hurt, and how. (1 to 2)
3. **The outcome:** the after screenshots, in the order a person would click through. Read out what is on screen in the screen's own words. (3 to 6, the core)
4. **Under the hood:** one `diagram`, gaining a box per moment. (2 to 3)
5. **Proof and risk:** one `terminal` frame with the real test and lint tails, then a Reveal giving the risk and how to roll back. (2)

Write each `"say"` the way it is spoken: "four twenty-nine", "package dot json". Use no em dashes in the lines.

## 4. Build, check, hand over

```
node "<skill>/scripts/animatic.mjs" build storyboard.json --target 90 --engine kokoro --voice af_heart
```

- If it stops on plan `WARN`s, cut moments or respell lines, then rerun. Frames and speech are cached.
- Read `sheet.png` against STYLE.md's sheet checklist. Fix the storyboard and rebuild, at most twice.
- Copy the MP4 out of the temp folder to a lasting place outside any repository, under a new name for every rebuild (`-v2`, `-v3`): a player may keep showing the first content of a path.
- **Never open the MP4** (no `open`, no player). Whoever asked adds or watches it.
- Hand over in 3 lines: the MP4 path, the run time and moment count, and any step that could not be captured.
- Feedback comes by moment number ("4 is too dense"). Change only those moments and rebuild.

## Upkeep

The tools live in `~/.cache/animatic` (override with `ANIMATIC_HOME`), shared by every run. `build` never installs anything: it stops and points at `check` and `setup`. Keep the constant 25 fps pass after `verify` in the build: without it the MP4 has one video frame per moment and players switch screens late, so the voice runs ahead of the picture. Keep the edits around the Kokoro loader too: only `setup` may reach Hugging Face, and it marks the voice model complete once it has spoken a line, so an interrupted download is listed again and a build makes no network calls.
