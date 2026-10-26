import 'dotenv/config';
import { getDb, closeDb } from './src/db/db.js'; const pool = getDb();
const d = await pool.query(`SELECT d.id,d.destination,d.version,d.review,d.approval,d.held,d.reason,d.reviewed_at,d.updated_at,t.title FROM publishing_drafts d JOIN publishing_topics t ON t.id=d.topic_id WHERE d.approval='approved' OR d.updated_at > NOW()-interval '2 days' ORDER BY d.updated_at DESC LIMIT 15`);
console.table(d.rows.map(r=>({title:r.title.slice(0,40),dest:r.destination,v:r.version,review:r.review,appr:r.approval,held:r.held,reason:(r.reason??'').slice(0,70),rev:r.reviewed_at?.toISOString?.(),upd:r.updated_at?.toISOString?.()})));
const e = await pool.query(`SELECT e.created_at,e.actor,e.event,left(e.detail::text,160) d,left(t.title,30) t FROM publishing_events e LEFT JOIN publishing_topics t ON t.id=e.topic_id WHERE e.created_at > NOW()-interval '20 hours' ORDER BY e.created_at DESC LIMIT 40`);
for (const r of e.rows) console.log(r.created_at.toISOString(), r.actor, r.event, r.t, r.d);
await closeDb();
