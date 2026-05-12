import { useState, useEffect, useMemo, useRef } from "react";

// ─── 날짜 유틸리티 ──────────────────────────────────────────
const parseLocal = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0);
};

const toDateStr = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const addDays = (date, n) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

// 셋째 주 토요일 계산
const getThirdSaturday = (year, month) => {
  const firstDay = new Date(year, month - 1, 1);
  const firstDayOfWeek = firstDay.getDay();
  const firstSat =
    firstDayOfWeek === 6 ? 1 : 1 + ((6 - firstDayOfWeek + 7) % 7);
  return new Date(year, month - 1, firstSat + 14, 0, 0, 0);
};

const ALL_SETTLEMENT_DATES = (() => {
  const dates = [];
  for (let y = 2024; y <= 2028; y++) {
    [3, 6, 9, 12].forEach((m) => dates.push(getThirdSaturday(y, m)));
  }
  return dates.sort((a, b) => a - b);
})();

// ─── 이자 계산 엔진 ─────────────────────────────────────────
const calcInterest = (
  transactions,
  rate,
  allSD,
  lastSettlement,
  nextPaymentDate,
) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!transactions.length) {
    return { liveAccrued: 0, expectedTotal: 0 };
  }

  const sorted = [...transactions].sort(
    (a, b) => parseLocal(a.date) - parseLocal(b.date),
  );
  let tempDate = parseLocal(sorted[0].date);
  let runningBalance = 0;
  let totalAccruedGains = 0; // 은행 전체 누적 (가산용)
  let currentPeriodInterest = 0; // 이번 분기 표시용

  while (tempDate < todayStart) {
    // [이자 가산 로직] 오늘이 '일요일(지급일)'이면 어제(토요일)까지의 이자를 원금에 더함
    const yesterday = addDays(tempDate, -1);
    const wasSettlementDay = allSD.some((sd) => isSameDay(sd, yesterday));
    if (wasSettlementDay) {
      runningBalance += Math.floor(totalAccruedGains);
      totalAccruedGains = 0;
    }

    // 당일 입출금 반영
    const dateStr = toDateStr(tempDate);
    transactions
      .filter((t) => t.date === dateStr)
      .forEach((t) => (runningBalance += t.amount));

    // 당일 이자 계산
    const dailyInterest = (runningBalance * (rate / 100)) / 365;
    totalAccruedGains += dailyInterest;

    // 이번 분기 이자 (지난 결산일 익일부터 누적)
    if (!lastSettlement || tempDate > lastSettlement) {
      currentPeriodInterest += dailyInterest;
    }

    tempDate = addDays(tempDate, 1);
  }

  // 오늘 실시간분
  const msSinceMidnight = now - todayStart;
  const dailyInterestToday = (runningBalance * (rate / 100)) / 365;
  const liveInterestToday = dailyInterestToday * (msSinceMidnight / 86400000);

  const liveAccrued = currentPeriodInterest + liveInterestToday;

  // 예상 총 이자: 다음 지급일(일요일 00:00)까지의 이자
  const msToNext = nextPaymentDate ? nextPaymentDate - now : 0;
  const futureInterest = dailyInterestToday * (msToNext / 86400000);
  const expectedTotal = liveAccrued + futureInterest;

  return { liveAccrued, expectedTotal };
};

// ─── 메인 컴포넌트 ──────────────────────────────────────────
export default function App() {
  // [로컬스토리지 복구] 초기값 불러오기
  const [transactions, setTransactions] = useState(() => {
    const saved = localStorage.getItem("parking_tx");
    return saved ? JSON.parse(saved) : [];
  });
  const [rate, setRate] = useState(() => {
    const saved = localStorage.getItem("parking_rate");
    return saved ? Number(saved) : 3.0;
  });

  const [inputAmount, setInputAmount] = useState("");
  const [inputDate, setInputDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [liveAccrued, setLiveAccrued] = useState(0);
  const [expectedTotal, setExpectedTotal] = useState(0);
  const timerRef = useRef(null);

  // 데이터 변경 시 로컬스토리지에 저장
  useEffect(() => {
    localStorage.setItem("parking_tx", JSON.stringify(transactions));
    localStorage.setItem("parking_rate", rate.toString());
  }, [transactions, rate]);

  const settlementInfo = useMemo(() => {
    const now = new Date();
    const lastDate = [...ALL_SETTLEMENT_DATES].reverse().find((d) => d <= now);
    const nextDate = ALL_SETTLEMENT_DATES.find((d) => d > now);
    // 지급일은 셋째 주 토요일(nextDate)의 다음 날
    const nextPaymentDate = nextDate ? addDays(nextDate, 1) : null;

    return { lastDate, nextDate, nextPaymentDate };
  }, []);

  const currentBalance = useMemo(
    () => transactions.reduce((acc, t) => acc + t.amount, 0),
    [transactions],
  );

  useEffect(() => {
    const update = () => {
      const { liveAccrued: la, expectedTotal: et } = calcInterest(
        transactions,
        rate,
        ALL_SETTLEMENT_DATES,
        settlementInfo.lastDate,
        settlementInfo.nextPaymentDate,
      );
      setLiveAccrued(la);
      setExpectedTotal(et);
    };
    update();
    timerRef.current = setInterval(update, 100);
    return () => clearInterval(timerRef.current);
  }, [transactions, rate, settlementInfo]);

  const dDay = settlementInfo.nextPaymentDate
    ? Math.ceil((settlementInfo.nextPaymentDate - new Date()) / 86400000)
    : null;

  const addTransaction = (type) => {
    const amount = Number(inputAmount);
    if (!amount || !inputDate) return;
    setTransactions((prev) => [
      ...prev,
      {
        id: Date.now(),
        date: inputDate,
        amount: type === "deposit" ? Math.abs(amount) : -Math.abs(amount),
        note: type === "deposit" ? "입금" : "출금",
      },
    ]);
    setInputAmount("");
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 pb-12 font-sans text-slate-800">
      <div className="w-full max-w-md">
        {/* 메인 카드 */}
        <div className="bg-blue-600 rounded-[2.5rem] p-8 shadow-2xl shadow-blue-200 mb-4 mt-4 relative overflow-hidden text-white">
          <div className="relative z-10">
            <h2 className="text-blue-100 text-xs font-bold uppercase tracking-widest mb-1">
              현재까지 쌓인 이자
            </h2>
            <div className="text-5xl font-black font-mono tracking-tighter mb-8">
              {liveAccrued.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              <span className="text-xl ml-1 font-sans font-normal opacity-80">
                원
              </span>
            </div>
            <div className="flex justify-between items-end border-t border-white/20 pt-6">
              <div>
                <p className="text-blue-200 text-[10px] font-bold uppercase">
                  이번 분기 예상 총 이자
                </p>
                <p className="text-xl font-bold font-mono">
                  {Math.floor(expectedTotal).toLocaleString()}원
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="bg-white/20 text-[10px] font-bold px-2 py-0.5 rounded-md">
                  D-{dDay}
                </span>
                <span className="text-[10px] font-medium text-blue-100 opacity-80">
                  {settlementInfo.nextPaymentDate?.toLocaleDateString("ko-KR", {
                    month: "long",
                    day: "numeric",
                  })}{" "}
                  지급
                </span>
              </div>
            </div>
          </div>
          <div className="absolute top-[-20%] right-[-10%] w-40 h-40 bg-white opacity-10 rounded-full" />
        </div>

        {/* 잔액/금리 섹션 */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">
              현재 잔액
            </p>
            <p className="text-lg font-black text-slate-700">
              {currentBalance.toLocaleString()}원
            </p>
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">
              적용 금리 설정
            </p>
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.1"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="text-lg font-black text-blue-600 bg-transparent outline-none w-16"
              />
              <span className="text-sm font-bold text-blue-600">%</span>
            </div>
          </div>
        </div>

        {/* 입력창 */}
        <div className="bg-white rounded-[2rem] p-6 shadow-sm mb-6 border border-slate-100">
          <div className="space-y-4">
            <div className="flex gap-2">
              {/* 날짜 입력창: flex-1과 min-w-0으로 정확히 절반 차지 */}
              <input
                type="date"
                value={inputDate}
                onChange={(e) => setInputDate(e.target.value)}
                className="flex-1 min-w-0 bg-slate-50 p-3 rounded-xl text-sm font-bold outline-none border border-transparent focus:border-blue-200"
              />
              {/* 금액 입력창: 동일하게 설정 */}
              <input
                type="number"
                placeholder="금액 입력"
                value={inputAmount}
                onChange={(e) => setInputAmount(e.target.value)}
                className="flex-1 min-w-0 bg-slate-50 p-3 rounded-xl text-sm font-bold outline-none border border-transparent focus:border-blue-200"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => addTransaction("deposit")}
                className="flex-1 bg-slate-800 text-white py-3.5 rounded-xl font-bold active:scale-95 transition-all text-sm"
              >
                입금 (+)
              </button>
              <button
                onClick={() => addTransaction("withdraw")}
                className="flex-1 bg-slate-100 text-slate-600 py-3.5 rounded-xl font-bold active:scale-95 transition-all text-sm"
              >
                출금 (-)
              </button>
            </div>
          </div>
        </div>

        {/* 거래 내역 리스트 */}
        <div className="space-y-2 overflow-y-auto max-h-[300px]">
          {[...transactions].reverse().map((t) => (
            <div
              key={t.id}
              className="bg-white p-4 rounded-2xl flex justify-between items-center shadow-sm border border-slate-50"
            >
              <div>
                <p className="text-[10px] text-slate-400 font-bold">{t.date}</p>
                <p className="text-sm font-bold text-slate-700">{t.note}</p>
              </div>
              <div className="flex items-center gap-3">
                <p
                  className={`font-bold ${t.amount > 0 ? "text-blue-600" : "text-rose-500"}`}
                >
                  {t.amount > 0 ? "+" : ""}
                  {t.amount.toLocaleString()}원
                </p>
                <button
                  onClick={() =>
                    setTransactions(
                      transactions.filter((item) => item.id !== t.id),
                    )
                  }
                  className="text-slate-300 hover:text-rose-400"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
