import fs from "fs";
import path from "path";

// Read .env.local manually
const envPath = path.resolve(process.cwd(), ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    env[match[1]] = match[2]?.trim().replace(/^["']|["']$/g, "");
  }
}

const secretKey = env.CLERK_SECRET_KEY;
if (!secretKey) {
  console.error("No CLERK_SECRET_KEY found in .env.local");
  process.exit(1);
}

const res = await fetch("https://api.clerk.com/v1/users?limit=100", {
  headers: {
    Authorization: `Bearer ${secretKey}`,
  },
});

if (!res.ok) {
  console.error("Clerk API error:", res.status, await res.text());
  process.exit(1);
}

const users = await res.json();
console.log("Total users found:", users.length);
for (const u of users) {
  const email = u.email_addresses?.[0]?.email_address;
  console.log({
    id: u.id,
    email,
    firstName: u.first_name,
    lastName: u.last_name,
    publicMetadata: u.public_metadata,
  });
}
