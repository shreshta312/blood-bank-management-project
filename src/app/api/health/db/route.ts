import { MongoClient } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const start = Date.now();
  const uri = process.env.MONGODB_URI;
  const name = process.env.MONGODB_DB_NAME;

  if (!uri) return Response.json({ db: "error", message: "MONGODB_URI not set" }, { status: 503 });
  if (!name) return Response.json({ db: "error", message: "MONGODB_DB_NAME not set" }, { status: 503 });

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000 });
  try {
    await client.connect();
    await client.db(name).command({ ping: 1 });
    return Response.json(
      { db: "ok", name, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number }).code;
    return Response.json(
      { db: "error", message, code, latencyMs: Date.now() - start },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
