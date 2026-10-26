/**
 * 京都大学 工学部 情報学科, 一般選抜 前期日程 — official figures only.
 *  - 配点: 令和9年度 京都大学入学者選抜要項（工学部の表）
 *  - 合格者の最高点・最低点・平均点: 京都大学「入学者選抜実施状況」令和5〜8年度
 *  - 日程・時間割: 同要項, 大学入試センター 令和9年度「受験案内」
 */

export const SOURCES = {
  yoko: 'https://www.kyoto-u.ac.jp/ja/admissions/undergrad/requirements',
  jisshi: 'https://www.kyoto-u.ac.jp/ja/admissions/undergrad/jisshijokyo',
  annai: 'https://www.dnc.ac.jp/kyotsu/shiken_jouhou/r9/',
};

/** 共通テストの素点を入れる科目（工学部は6教科8科目）. */
export const KYOTSU_SUBJECTS = [
  { id: 'kokugo', label: '国語', max: 200 },
  { id: 'chireki', label: '地歴・公民', max: 100 },
  { id: 'mathIA', label: '数学Ⅰ・A', max: 100 },
  { id: 'mathIIBC', label: '数学Ⅱ・B・C', max: 100 },
  { id: 'sci1', label: '物理', max: 100 },
  { id: 'sci2', label: '化学 / 生物', max: 100 },
  { id: 'engR', label: '英語リーディング', max: 100 },
  { id: 'engL', label: '英語リスニング', max: 100 },
  { id: 'info', label: '情報Ⅰ', max: 100 },
] as const;

export type KyotsuId = (typeof KYOTSU_SUBJECTS)[number]['id'];

/** 共通テストの配点（換算後, 計225）: 国語25 地歴公民50 数学25 理科25 外国語50 情報50. 英語はR100+L100の200点満点で利用. */
export const KYOTSU_GROUPS: { label: string; ids: KyotsuId[]; points: number }[] = [
  { label: '国語', ids: ['kokugo'], points: 25 },
  { label: '地歴・公民', ids: ['chireki'], points: 50 },
  { label: '数学', ids: ['mathIA', 'mathIIBC'], points: 25 },
  { label: '理科', ids: ['sci1', 'sci2'], points: 25 },
  { label: '外国語', ids: ['engR', 'engL'], points: 50 },
  { label: '情報', ids: ['info'], points: 50 },
];

/** 個別学力検査の配点（計800）. */
export const NIJI_SUBJECTS = [
  { id: 'kokugo', label: '国語', max: 100 },
  { id: 'math', label: '数学', max: 250 },
  { id: 'sci', label: '理科', max: 250 },
  { id: 'eng', label: '外国語', max: 200 },
] as const;

export type NijiId = (typeof NIJI_SUBJECTS)[number]['id'];

export const KYOTSU_FULL = 225;
export const NIJI_FULL = 800;
export const TOTAL_FULL = KYOTSU_FULL + NIJI_FULL;

/** 情報学科の合格者（総点）. 令和7年度から共通テストに情報が入り満点1025. */
export const PAST_RESULTS = [
  { year: '令和8年度（2026）', full: 1025, max: 822.62, min: 645.49, avg: 694.29 },
  { year: '令和7年度（2025）', full: 1025, max: 843.87, min: 707.52, avg: 748.86 },
  { year: '令和6年度（2024）', full: 1000, max: 778.08, min: 623.2, avg: 676.54 },
  { year: '令和5年度（2023）', full: 1000, max: 836.45, min: 697.7, avg: 739.16 },
];

const KYOTSU_MAX = new Map<string, number>(KYOTSU_SUBJECTS.map((s) => [s.id, s.max]));

export interface Conversion {
  groups: { label: string; raw: number; rawMax: number; points: number; converted: number; complete: boolean }[];
  total: number;
  /** Every subject has a score. */
  complete: boolean;
}

/** 素点 → 京大工学部の共通テスト換算点 (each group scaled to its 配点). */
export function convertKyotsu(raw: Partial<Record<KyotsuId, number>>): Conversion {
  const groups = KYOTSU_GROUPS.map((g) => {
    const rawMax = g.ids.reduce((s, id) => s + KYOTSU_MAX.get(id)!, 0);
    const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
    const got = g.ids.reduce((s, id) => s + (ok(raw[id]) ? clamp(raw[id]!, 0, KYOTSU_MAX.get(id)!) : 0), 0);
    return { label: g.label, raw: got, rawMax, points: g.points, converted: (got / rawMax) * g.points, complete: g.ids.every((id) => ok(raw[id])) };
  });
  return { groups, total: groups.reduce((s, g) => s + g.converted, 0), complete: groups.every((g) => g.complete) };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function nijiTotal(scores: Partial<Record<NijiId, number>>): number {
  return NIJI_SUBJECTS.reduce((s, x) => s + clamp(Number.isFinite(scores[x.id]) ? scores[x.id]! : 0, 0, x.max), 0);
}

/** What 二次 needs to reach `target` total with this 共通テスト換算点 (null when out of reach). */
export function nijiNeeded(kyotsu: number, target: number): { points: number; pct: number } | null {
  const need = Math.max(0, target - kyotsu);
  if (need > NIJI_FULL) return null;
  return { points: need, pct: need / NIJI_FULL };
}

// ---------- 日程 ----------

export interface Slot {
  start: string;
  end: string;
  subject: string;
  minutes: number;
}

export interface ExamEvent {
  date: string;
  /** Last day of a period (出願期間). */
  until?: string;
  title: string;
  detail?: string;
  slots?: Slot[];
}

/** 令和9年度（2027年）入試. 共通テストの時間割は工学部の受験者（地歴公民1科目・理科2科目）のもの. */
export const SCHEDULE_R9: ExamEvent[] = [
  { date: '2026-12-04', title: '共通テストの受験票を取得', detail: '10時からマイページで各自取得し、紙に印刷する（スマホの画面では入場できない）' },
  {
    date: '2027-01-16',
    title: '共通テスト 1日目',
    slots: [
      { start: '10:40', end: '11:40', subject: '地歴・公民（1科目）', minutes: 60 },
      { start: '13:00', end: '14:30', subject: '国語', minutes: 90 },
      { start: '15:20', end: '16:40', subject: '英語リーディング', minutes: 80 },
      { start: '17:20', end: '18:20', subject: '英語リスニング', minutes: 60 },
    ],
    detail: '遅刻は開始20分後まで。リスニングは17:20までに入室していないと受けられない',
  },
  {
    date: '2027-01-17',
    title: '共通テスト 2日目',
    slots: [
      { start: '09:30', end: '10:30', subject: '理科 第1解答科目', minutes: 60 },
      { start: '10:40', end: '11:40', subject: '理科 第2解答科目', minutes: 60 },
      { start: '13:00', end: '14:10', subject: '数学Ⅰ・A', minutes: 70 },
      { start: '15:00', end: '16:10', subject: '数学Ⅱ・B・C', minutes: 70 },
      { start: '17:00', end: '18:00', subject: '情報Ⅰ', minutes: 60 },
    ],
    detail: '理科2科目は9:50までに入室しないと2科目とも受けられない。科目の間の10分は退室できない',
  },
  { date: '2027-01-25', until: '2027-02-03', title: '京大 出願（Web出願登録・検定料納入・書類受理）' },
  { date: '2027-02-10', title: '京大 第1段階選抜 合格者発表', detail: '工学部は志願者が募集人員の約3.0倍を超えると、共通テストの得点で行うことがある' },
  {
    date: '2027-02-25',
    title: '京大 個別学力検査 1日目',
    slots: [
      { start: '09:30', end: '11:00', subject: '国語', minutes: 90 },
      { start: '13:30', end: '16:00', subject: '数学', minutes: 150 },
    ],
  },
  {
    date: '2027-02-26',
    title: '京大 個別学力検査 2日目',
    slots: [
      { start: '09:30', end: '11:30', subject: '外国語（英語）', minutes: 120 },
      { start: '13:30', end: '16:30', subject: '理科', minutes: 180 },
    ],
  },
  { date: '2027-03-10', title: '京大 合格者発表' },
];

// ---------- 持ち物 ----------

export interface CheckItem {
  id: string;
  text: string;
  note?: string;
}

/** 共通テスト: 受験案内（令和9年度）の「試験時間中に机の上に置けるもの」と必携品. */
export const CHECK_KYOTSU: CheckItem[] = [
  { id: 'k-ticket', text: '受験票（紙に印刷したもの）', note: 'スマホの画面では入場できない' },
  { id: 'k-id', text: '顔写真付きの身分証明書', note: '生徒証・マイナンバーカード・パスポート等（氏名・生年月日入り、有効なもの）' },
  { id: 'k-pencil', text: '黒鉛筆（H・F・HB）と鉛筆キャップ', note: '和歌・格言等が印刷されたものは不可。マークは黒鉛筆で（シャープペンシルは読み取れないことがある）' },
  { id: 'k-sharp', text: 'シャープペンシル（黒い芯）', note: 'メモ・計算用のみ' },
  { id: 'k-eraser', text: 'プラスチック製の消しゴム' },
  { id: 'k-sharpener', text: '鉛筆削り', note: '電動式・大型のもの・ナイフ類は不可' },
  { id: 'k-watch', text: '時計', note: '辞書・電卓・端末等の機能があるもの、秒針音のするもの、キッチンタイマー・学習タイマー・大型のものは不可' },
  { id: 'k-misc', text: '眼鏡・ハンカチ・目薬・ティッシュ', note: 'ティッシュは袋や箱から中身だけ出す' },
  { id: 'k-shoes', text: '上履きと下履きを入れる袋', note: '受験票に「上履き持参」とある場合' },
];

/** 共通テストで試験時間中に使えないもの（身に付けているだけで不正行為になりうる）. */
export const KYOTSU_FORBIDDEN = [
  '定規・コンパス・電卓・そろばん・グラフ用紙',
  'スマホ・スマートウォッチ・タブレット・電子辞書・イヤホン等：アラームを解除し電源を切ってかばんへ（ポケットはだめ）',
  '英文字や地図がプリントされた服は着ない',
];

/** 京大 二次: 正式な注意は受験票と一緒に届く京大の案内で確認する. ここは自分で足す前提の基本だけ. */
export const CHECK_NIJI: CheckItem[] = [
  { id: 'n-ticket', text: '京大の受験票' },
  { id: 'n-pens', text: '筆記用具・消しゴム' },
  { id: 'n-watch', text: '時計' },
  { id: 'n-lunch', text: '昼食・飲み物', note: '2日とも昼をまたぐ（午前と午後に1科目ずつ）' },
];
