const admin = require('firebase-admin');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function sendToSlack(blocks) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });
  if (!res.ok) {
    console.error('❌ 送信失敗:', await res.text());
    process.exit(1);
  }
  // Slackのレート制限対策に少し待つ
  await new Promise(r => setTimeout(r, 500));
}

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
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekLabel = `${fmt(monday)}〜${fmt(sunday)}`;

  const snap = await db.collection('lc-tracker-2627').doc('main').get();
  if (!snap.exists) { console.log('データなし'); return; }

  const payload = JSON.parse(snap.data().payload || '{}');
  const hi = (payload.lcs || []).find(lc => lc.id === 'HI');
  if (!hi) { console.log('HIデータなし'); return; }

  const taskAlerts = [];
  const todoByArea = {};

  Object.entries(hi.areas || {}).forEach(([areaId, area]) => {
    (area.kpis || []).forEach(kpi => {
      (kpi.tasks || []).forEach(task => {
        if (task.deadline && task.status !== 'DONE') {
          const deadline = toDate(task.deadline);
          if (deadline >= today && deadline <= in3days) {
            const daysLeft = Math.round((deadline - today) / 86400000);
            taskAlerts.push({ areaId, kpiName: kpi.name, taskName: task.name, res: task.res, deadline: task.deadline, daysLeft, status: task.status });
          }
        }
        const pendingTodos = (task.todos || []).filter(td => td.week === thisWeekKey && !td.done);
        if (pendingTodos.length > 0) {
          if (!todoByArea[areaId]) todoByArea[areaId] = { linkedByTask: {}, manual: [] };
          todoByArea[areaId].linkedByTask[task.name] = {
            res: task.res || '',
            todos: pendingTodos.map(td => td.name)
          };
        }
      });
    });
    (area.weekTodos || []).forEach(todo => {
      if (todo.week === thisWeekKey && !todo.done) {
        if (!todoByArea[areaId]) todoByArea[areaId] = { linkedByTask: {}, manual: [] };
        todoByArea[areaId].manual.push({ name: todo.name, res: todo.res || '' });
      }
    });
  });

  const trackerLink = '<https://kuronumaharunosuke.github.io/lc-tracker/#lc-HI|Action Tracker - HI>';

  // ===== 投稿1: 締切3日以内タスク =====
  if (taskAlerts.length > 0) {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `⚠️ HI 締切3日以内タスク (${fmt(today)})`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `全${taskAlerts.length}件` }] },
      { type: 'divider' }
    ];

    const byArea = {};
    taskAlerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });
    Object.entries(byArea).forEach(([areaId, tasks]) => {
      const lines = tasks.map(t => {
        const urgency = t.daysLeft === 0 ? '🔴' : t.daysLeft === 1 ? '🟠' : '🟡';
        const dayLabel = t.daysLeft === 0 ? '今日' : t.daysLeft === 1 ? '明日' : `${t.daysLeft}日後`;
        const status = t.status === 'WIP' ? 'WIP' : '未着手';
        return `${urgency} *${t.taskName}* — ${dayLabel} (${t.deadline})  \`${status}\`${t.res ? `  担当: ${t.res}` : ''}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}* (${tasks.length}件)\n${lines}` } });
    });

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🔗 ${trackerLink}` }] });
    await sendToSlack(blocks);
    console.log(`✅ 投稿1: タスク${taskAlerts.length}件`);
  }

  // ===== 投稿2〜: エリアごとの週次ToDo =====
  const areaIds = Object.keys(todoByArea);
  for (const areaId of areaIds) {
    const data = todoByArea[areaId];
    const linkedCount = Object.values(data.linkedByTask).reduce((s, t) => s + t.todos.length, 0);
    const totalCount = linkedCount + data.manual.length;

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📋 HI ${areaId} 今週のToDo`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${weekLabel}  未完了${totalCount}件` }] },
      { type: 'divider' }
    ];

    const chunks = [];
    Object.entries(data.linkedByTask).forEach(([taskName, info]) => {
      const resLabel = info.res ? ` — ${info.res}` : '';
      chunks.push(`📂 *${taskName}*${resLabel}`);
      info.todos.forEach(td => chunks.push(`   • ${td}`));
      chunks.push('');
    });
    if (data.manual.length > 0) {
      chunks.push(`✏️ *手動追加*`);
      data.manual.forEach(m => {
        chunks.push(`   • ${m.name}${m.res ? `  担当: ${m.res}` : ''}`);
      });
    }

    // 2900字制限で分割
    let buf = '';
    for (const line of chunks) {
      if ((buf + line + '\n').length > 2900) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
        buf = '';
      }
      buf += line + '\n';
    }
    if (buf.trim()) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🔗 ${trackerLink}` }] });
    await sendToSlack(blocks);
    console.log(`✅ 投稿: ${areaId} ToDo${totalCount}件`);
  }

  if (taskAlerts.length === 0 && areaIds.length === 0) {
    console.log('アラート対象なし');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
