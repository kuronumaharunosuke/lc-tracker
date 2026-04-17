const admin = require('firebase-admin');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function postMessage(blocks, thread_ts) {
  const body = { channel: process.env.SLACK_CHANNEL_ID, blocks };
  if (thread_ts) body.thread_ts = thread_ts;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Slack API error:', data.error, data);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 600));
  return data.ts;
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
  const weekLabel = `${fmt(monday)} - ${fmt(sunday)}`;

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

  if (taskAlerts.length > 0) {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `:warning: *HI 締切3日以内タスク (${fmt(today)})*  —  全${taskAlerts.length}件` } },
      { type: 'divider' }
    ];
    const byArea = {};
    taskAlerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });
    Object.entries(byArea).forEach(([areaId, tasks]) => {
      const lines = tasks.map(t => {
        const urgency = t.daysLeft === 0 ? ':red_circle:' : t.daysLeft === 1 ? ':large_yellow_circle:' : ':large_blue_circle:';
        const dayLabel = t.daysLeft === 0 ? '今日' : t.daysLeft === 1 ? '明日' : `${t.daysLeft}日後`;
        const status = t.status === 'WIP' ? 'WIP' : '未着手';
        return `${urgency} *${t.taskName}* — ${dayLabel} (${t.deadline})  \`${status}\`${t.res ? `  担当: ${t.res}` : ''}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}* (${tasks.length}件)\n${lines}` } });
    });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: trackerLink }] });
    await postMessage(blocks);
    console.log(`締切タスク投稿: ${taskAlerts.length}件`);
  }

  for (const [areaId, data] of Object.entries(todoByArea)) {
    const linkedCount = Object.values(data.linkedByTask).reduce((s, t) => s + t.todos.length, 0);
    const totalCount = linkedCount + data.manual.length;

    const parentBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `:warning: *HI ${areaId} — 今週のToDo*` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${weekLabel}  未完了${totalCount}件  （詳細はスレッド）` }] }
    ];
    const parentTs = await postMessage(parentBlocks);

    const chunks = [];
    Object.entries(data.linkedByTask).forEach(([taskName, info]) => {
      const resLabel = info.res ? ` — ${info.res}` : '';
      chunks.push(`*${taskName}*${resLabel}`);
      info.todos.forEach(td => chunks.push(`   ・ ${td}`));
      chunks.push('');
    });
    if (data.manual.length > 0) {
      chunks.push(`*手動追加*`);
      data.manual.forEach(m => {
        chunks.push(`   ・ ${m.name}${m.res ? `  担当: ${m.res}` : ''}`);
      });
    }

    let buf = '';
    const sections = [];
    for (const line of chunks) {
      if ((buf + line + '\n').length > 2900) {
        sections.push(buf);
        buf = '';
      }
      buf += line + '\n';
    }
    if (buf.trim()) sections.push(buf);

    for (const sec of sections) {
      await postMessage([{ type: 'section', text: { type: 'mrkdwn', text: sec } }], parentTs);
    }
    console.log(`${areaId}: ${totalCount}件 (${sections.length}スレ返信)`);
  }

  if (taskAlerts.length === 0 && Object.keys(todoByArea).length === 0) {
    console.log('アラート対象なし');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
