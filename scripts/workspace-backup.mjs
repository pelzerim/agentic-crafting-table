import { createBackup, prepareRecovery, verifyBackup } from '../packages/workspace-backup/backup.ts';

const [command, source, destination, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !source || !['create', 'verify', 'prepare-recovery'].includes(command) || (command === 'verify' ? !!destination : !destination)) throw new Error('Usage: npm run workspace:backup -- create <closed-profile> <new-backup-folder> | verify <backup-folder> | prepare-recovery <backup-folder> <new-recovery-folder>');
  if (command === 'create') {
    const result = createBackup(source, destination);
    console.log(`Backup complete: ${result.entries.length} entries. Keep this private: it contains project context and terminal recordings. Native conversations and credentials are not included.`);
  } else if (command === 'verify') {
    const result = verifyBackup(source);
    console.log(`Backup verified: ${result.entries.length} entries; file checksums and SQLite integrity passed.`);
  } else {
    const result = prepareRecovery(source, destination);
    console.log(`Recovery copy ready: ${result.profile}\nOriginal location: ${result.sourceDirectory}\nThe current workspace was not replaced. No sessions were started. Read READY.json before activation.`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
