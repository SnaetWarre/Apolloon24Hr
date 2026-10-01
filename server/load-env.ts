// Imported first by index.ts: other server modules read process.env while they load.
// Variables already set in the environment win over the file; a missing .env is fine.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
