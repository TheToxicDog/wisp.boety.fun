// Account recovery from the VPS shell. Stop the service first so its
// in-memory state doesn't overwrite these changes:
//   sudo systemctl stop wisp && sudo -u wisp DATA_DIR=/var/lib/wisp node /opt/wisp.boety.fun/scripts/admin.js reset-password NAME; sudo systemctl start wisp
// Commands: list | reset-password NAME
const { _internal: db } = await import("../lib/auth.js");
const [cmd, arg] = process.argv.slice(2);

if (cmd === "list") {
  for (const u of Object.values(db.users)) console.log(`${u.name.padEnd(24)} ${u.role.padEnd(6)} ${u.status}`);
} else if (cmd === "reset-password" && arg) {
  const u = db.users[arg.toLowerCase()];
  if (!u) { console.error(`No user "${arg}"`); process.exit(1); }
  const pw = db.tempPassword();
  u.hash = await db.hashPassword(pw);
  u.mustChangePassword = true;
  if (u.status === "disabled") u.status = "active";
  db.saveUsersNow();
  db.revokeAll(u.name);
  console.log(`Temporary password for ${u.name}: ${pw}\nThey'll be asked to choose a new one when they sign in.`);
} else {
  console.log("Usage: admin.js list | reset-password NAME");
  process.exit(1);
}
process.exit(0);
