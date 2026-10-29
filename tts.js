// Text to speech, done by the bot outside Codex's sandbox (the sandbox blocks
// the Windows speech engine). Codex saves the words in a *.say.txt file and
// the bot turns it into a WAV. Windows uses its built-in voices; Linux uses
// espeak-ng.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

// Paths go in through the environment so no quoting is needed.
const PS_SPEAK = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.SetOutputToWaveFile($env:TTS_OUT)',
  '$s.Speak([IO.File]::ReadAllText($env:TTS_IN))',
  '$s.Dispose()',
].join('; ');

let available = null;

export async function ttsAvailable() {
  if (available === null) {
    try {
      if (IS_WINDOWS) {
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech'], { timeout: 30000, windowsHide: true });
      } else {
        await exec('espeak-ng', ['--version'], { timeout: 10000 });
      }
      available = true;
    } catch {
      available = false;
    }
  }
  return available;
}

export async function speak(textFile, wavFile) {
  if (IS_WINDOWS) {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SPEAK], {
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, TTS_IN: textFile, TTS_OUT: wavFile },
    });
  } else {
    await exec('espeak-ng', ['-w', wavFile, '-f', textFile], { timeout: 120000 });
  }
}
