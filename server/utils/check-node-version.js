const requiredMajor = '24';
const [currentMajor] = process.versions.node.split('.');

if (currentMajor !== requiredMajor) {
  const message = `NexusChat requires Node.js ${requiredMajor}.x for its built-in SQLite database. Running ${process.version}.`
    + ` With nvm, run "nvm install ${requiredMajor}" or "nvm use ${requiredMajor}", then restart the app.`;
  if (require.main !== module) throw new Error(message);
  console.error(message);
  process.exitCode = 1;
}
