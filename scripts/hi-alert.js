const admin = require('firebase-admin');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in3days = new Date(today);
  in3days.setDate(in3days.getDate() + 3);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const toDate = (s) => { const d = new Date(s); d.setHours(0,0,0,0); return d; };

  const snap = await db.collection('lc-tracker-2627').doc('main').get();
  if (!snap.exists) { console.log('データなし'); return; }
  const data = snap.data();
  const payload = JSON.parse(data.payload || '{}');
  const lcs = payload.lcs || [];
  const hi = lcs.find(lc => lc.id === 'HI');
  if (!hi) { console.log('HIデータなし'); return; }

  const alerts = [];
  Object.entries(hi.areas || {}).forEach(([areaId, area]) => {
    (area.kpis || []).forEach(kpi => {
      (kpi.tasks || []).forEach(task => {
        if (!task.deadline || task.status === 'DONE') return;
        const deadline = toDate(task.deadline);
        if (deadline >= today && deadline <= in3days) {
          const daysLeft = Math.round((deadline - today) / 86400000);
          alerts.push({ areaId, kpiName: kpi.name, taskName: task.name, res: task.res, deadline: task.deadline, daysLeft, status: task.status });
        }
      });
    });
  });

  if (alerts.length === 0) { console.log('アラート対象タスクなし'); return; }

  const byArea = {};
  alerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `⚠️ HI 締め切り3日以内アラート（${fmt(today)}）`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `対象タスク: *${alerts.length}件*` }] },
    { type: 'divider' }
  ];

  Object.entries(byArea).forEach(([areaId, tasks]) => {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}*` } });
    tasks.forEach(t => {
      const urgency = t.daysLeft === 0 ? '🔴 今日' : t.daysLeft === 1 ? '🟠 明日' : `🟡 ${t.daysLeft}日後`;
      const status = t.status === 'WIP' ? '▶ WIP' : '○ 未着手';
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${urgency} *${t.taskName}*\n${status}  締切: ${t.deadline}${t.res ? `  担当: ${t.res}` : ''}\n_${t.kpiName}_` } });
    });
    blocks.push({ type: 'divider' });
  });

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🔗 <https://kuronumaharunosuke.github.io/lc-tracker/#lc-HI|Action Tracker - HI>' }] });

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (res.ok) { console.log(`✅ Slack送信完了 (${alerts.length}件)`); }
  else { console.error('❌ Slack送信失敗:', await res.text()); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
