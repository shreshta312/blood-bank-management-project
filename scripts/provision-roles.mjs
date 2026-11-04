import fs from "fs";
import path from "path";

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
const stateId = env.REGISTRY_STATE_ID || "maharashtra-pilot";

const accounts = [
  {
    username: "state_admin",
    email_address: ["admin@pulsegrid.org"],
    phone_number: ["+15555550100"],
    password: "PulseGridAdmin2024!",
    first_name: "State",
    last_name: "Admin",
    public_metadata: {
      registry: {
        role: "STATE_ADMIN",
        stateId,
      },
    },
  },
  {
    username: "bank_operator",
    email_address: ["bank@pulsegrid.org"],
    phone_number: ["+15555550101"],
    password: "PulseGridBank2024!",
    first_name: "Bank",
    last_name: "Operator",
    public_metadata: {
      registry: {
        role: "BANK",
        stateId,
        tenantId: "tenant-demo-bank-1",
        bankId: "demo-bank-1",
      },
    },
  },
  {
    username: "hospital_officer",
    email_address: ["hospital@pulsegrid.org"],
    phone_number: ["+15555550102"],
    password: "PulseGridHospital2024!",
    first_name: "Hospital",
    last_name: "Officer",
    public_metadata: {
      registry: {
        role: "HOSPITAL",
        stateId,
        tenantId: "tenant-demo-hospital-1",
        hospitalId: "demo-hospital-1",
      },
    },
  },
  {
    username: "donor_user",
    email_address: ["donor@pulsegrid.org"],
    phone_number: ["+15555550103"],
    password: "PulseGridDonor2024!",
    first_name: "Registered",
    last_name: "Donor",
    public_metadata: {
      registry: {
        role: "DONOR",
        stateId,
        tenantId: "tenant-demo-donor-1",
        donorId: "demo-donor-1",
      },
    },
  },
];

console.log(`Provisioning ${accounts.length} Clerk accounts for state: ${stateId}...`);

for (const account of accounts) {
  // Check if user already exists
  const listRes = await fetch(`https://api.clerk.com/v1/users?username=${account.username}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const existingUsers = listRes.ok ? await listRes.json() : [];
  const existing = existingUsers.find(u => u.username === account.username);

  if (existing) {
    console.log(`User '${account.username}' already exists (${existing.id}). Updating metadata...`);
    const updateRes = await fetch(`https://api.clerk.com/v1/users/${existing.id}/metadata`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        public_metadata: account.public_metadata,
      }),
    });
    if (!updateRes.ok) {
      console.error(`Failed to update metadata for ${account.username}:`, await updateRes.text());
    } else {
      console.log(`✓ Updated '${account.username}' successfully.`);
    }
  } else {
    console.log(`Creating user '${account.username}' (${account.public_metadata.registry.role})...`);
    const createRes = await fetch("https://api.clerk.com/v1/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(account),
    });
    if (!createRes.ok) {
      console.error(`Failed to create ${account.username}:`, await createRes.text());
    } else {
      const created = await createRes.json();
      console.log(`✓ Created '${account.username}' (${created.id}) successfully.`);
    }
  }
}

console.log("\nAll accounts provisioned!");
