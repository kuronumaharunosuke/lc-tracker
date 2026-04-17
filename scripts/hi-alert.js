const admin = require('firebase-admin');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in3days = new Date(today);
  in3days.setDate(in3days.getDate() + 3);

  const fmt = (d) => `${d.getMonth()+1}/${d.getDate()}`;
  const toDate = (s) => { const d = new Date(s); d.setHours(0,0,0,0); return d; };

  const todayDay = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (todayDay === 0 ? 6 : todayDay - 1));
  const thisWeekKey = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;

  const snap = await db.collection('lc-tracker-2627').doc('main').get();
  if (!snap.exists) { console.log('データなし'); return; }

  const payload = JSON.parse(snap.data().payload || '{}');
  const hi = (payload.lcs || []).find(lc => lc.id === 'HI');
  if (!hi) { console.log('HIデータなし'); return; }

  const taskAlerts = [];
  const todoAlerts = [];

  Object.entries(hi.areas || {}).forEach(([areaId, area]) => {
    // 3日以内タスク
    (area.kpis || []).forEach(kpi => {
      (kpi.tasks || []).forEach(task => {
        if (task.deadline && task.status !== 'DONE') {
          const deadline = toDate(task.deadline);
          if (deadline >= today && deadline <= in3days) {
            const daysLeft = Math.round((deadline - today) / 86400000);
            taskAlerts.push({ areaId, kpiName: kpi.name, taskName: task.name, res: task.res, deadline: task.deadline, daysLeft, status: task.status });
          }
        }
        // タスク連携TODO (task.todos[].week)
        (task.todos || []).forEach(td => {
          if (td.week === thisWeekKey && !td.done) {
            todoAlerts.push({ areaId, name: td.name, res: task.res || '', parent: task.name, kind: '連携' });
          }
        });
      });
    });
    // 手動週次ToDo
    (area.weekTodos || []).forEach(todo => {
      if (todo.week === thisWeekKey && !todo.done) {
        todoAlerts.push({ areaId, name: todo.name, res: todo.res || '', kind: '手動' });
      }
    });
  });

  if (taskAlerts.length === 0 && todoAlerts.length === 0) {
    console.log('アラート対象なし'); return;
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `⚠️ HI アラート（${fmt(today)}）`, emoji: true } },
    { type: 'divider' }
  ];

  if (taskAlerts.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*締め切り3日以内のタスク（${taskAlerts.length}件）*` } });
    const byArea = {};
    taskAlerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });
    Object.entries(byArea).forEach(([areaId, tasks]) => {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}*` } });
      tasks.forEach(t => {
        const urgency = t.daysLeft === 0 ? '🔴 今日' : t.daysLeft === 1 ? '🟠 明日' : `🟡 ${t.daysLeft}日後`;
        const status = t.status === 'WIP' ? '▶ WIP' : '○ 未着手';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${urgency} *${t.taskName}*\n${status}  締切: ${t.deadline}${t.res ? `  担当: ${t.res}` : ''}\n_${t.kpiName}_` } });
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (todoAlerts.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*今週の週次ToDo（未完了 ${todoAlerts.length}件）*` } });
    const byArea = {};
    todoAlerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });
    Object.entries(byArea).forEach(([areaId, todos]) => {
      const lines = todos.map(t => {
        const tag = t.kind === '連携' ? '[連携]' : '[手動]';
        const parent = t.parent ? ` _(${t.parent})_` : '';
        return `• ${tag} ${t.name}${parent}${t.res ? `  担当: ${t.res}` : ''}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}*\n${lines}` } });
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🔗 <https://kuronumaharunosuke.github.io/lc-tracker/#lc-HI|Action Tracker - HI>' }] });

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (res.ok) { console.log(`✅ 送信完了 (タスク${taskAlerts.length}件 / ToDo${todoAlerts.length}件)`); }
  else { console.error('❌ 送信失敗:', await res.text()); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
