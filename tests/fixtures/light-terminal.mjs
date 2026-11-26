// Static ANSI rows for the light terminal: the styles Claude Code uses for secondary text, white bars and reverse video.
// One label per row, so tests can find each style by its text. No model or external I/O.
process.stdout.write('\x1b[2J\x1b[H' + [
  '\x1b[37mRan 3 shell commands\x1b[0m',
  '\x1b[2;37m  Interrupted · What should Claude do instead?\x1b[0m',
  '\x1b[97;100m > open a pr for this \x1b[0m',
  '\x1b[2mrecap: dim text in the default colour\x1b[0m',
  '\x1b[90mhint in bright black\x1b[0m  \x1b[97mbright white text\x1b[0m',
  '\x1b[30;47m black on white \x1b[0m \x1b[30;107m black on bright white \x1b[0m',
  '\x1b[7m reverse video \x1b[0m \x1b[7;37m reverse white \x1b[0m',
  'Light terminal fixture ready',
].join('\r\n') + '\r\n');
