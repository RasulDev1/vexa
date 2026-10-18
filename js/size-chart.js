// Таблица размеров в карточке товара — российская размерная сетка, как на Wildberries и Ozon.
// Готовые таблицы: «Верх», «Низ», «Обувь». Сотрудник выбирает таблицу товару и может поправить сантиметры;
// правки хранятся в каталоге: sizeCharts[id] = { type, rows: { "размер": [ячейки строки] } }.
import { escapeHtml } from "./core.js?v=20261001b";
import { state } from "./state.js?v=20261001b";

const HEIGHT = ["170–176", "170–176", "176–182", "176–182", "176–182", "182–188", "182–188"];
const LETTERS = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];
const RU = ["44", "46", "48", "50", "52", "54", "56"];
const range = (from, i) => `${from + i * 4}–${from + i * 4 + 3}`;

export const CHART_TYPES = {
  tops: {
    title: "Верх",
    hint: "футболки, худи, свитшоты, куртки",
    columns: ["Размер", "Российский", "Обхват груди, см", "Обхват талии, см", "Рост, см"],
    rows: LETTERS.map((s, i) => [s, RU[i], range(86, i), range(74, i), HEIGHT[i]]),
    measure: { column: 2, label: "Обхват груди, см", placeholder: "Например, 96" },
  },
  bottoms: {
    title: "Низ",
    hint: "штаны, брюки, шорты",
    columns: ["Размер", "Российский", "Обхват талии, см", "Обхват бёдер, см", "Рост, см"],
    rows: LETTERS.map((s, i) => [s, RU[i], range(74, i), range(92, i), HEIGHT[i]]),
    measure: { column: 2, label: "Обхват талии, см", placeholder: "Например, 84" },
  },
  shoes: {
    title: "Обувь",
    hint: "кроссовки, кеды",
    columns: ["Российский", "Европейский", "США", "Длина стопы, см"],
    rows: [["38", "39", "6.5", "25"], ["39", "40", "7", "25.5"], ["40", "41", "8", "26"], ["41", "42", "8.5", "26.5"],
      ["42", "43", "9.5", "27.5"], ["43", "44", "10", "28"], ["44", "45", "11", "29"], ["45", "46", "12", "29.5"],
      ["46", "47", "12.5", "30.5"], ["47", "48", "13", "31"]],
    measure: { column: 3, label: "Длина стопы, см", placeholder: "Например, 27" },
  },
};

const HOW_TO_MEASURE = {
  tops: "Обхват груди — по самым выступающим точкам груди, лента проходит под мышками. Обхват талии — по самому узкому месту.",
  bottoms: "Обхват талии — по самому узкому месту, не втягивая живот. Обхват бёдер — по самым выступающим точкам ягодиц.",
  shoes: "Встаньте на лист бумаги, отметьте пятку и самый длинный палец и измерьте расстояние. Меряйте вечером: к концу дня стопа чуть больше.",
};

/** Таблица по умолчанию — по названию и размерам товара */
export function guessChartType(product) {
  if (product.sizes.length === 1 && /one\s*size|универс/i.test(product.sizes[0])) return "none";
  const name = String(product.name).toLowerCase();
  if (/кроссов|кеды|ботин|обув|кед\b|слипон|сникер/.test(name)) return "shoes";
  if (/штан|брюк|шорт|леггин|лосин|тайтс|джогер|джинс/.test(name)) return "bottoms";
  if (/кепк|шапк|панам|носк|сумк|рюкзак|перчат/.test(name)) return "none";
  return "tops";
}

/** Строка готовой таблицы для размера: ищем и по буквенному, и по российскому размеру */
function templateRow(type, size) {
  const s = String(size).trim().toUpperCase().replace(/^XXXL$/, "3XL");
  return CHART_TYPES[type].rows.find((row) => row[0].toUpperCase() === s || (type !== "shoes" && row[1] === s));
}

/** Строки таблицы для размеров товара: правка сотрудника → готовая строка → пустые ячейки */
export function chartRows(product, type, custom = {}) {
  const t = CHART_TYPES[type];
  return product.sizes.map((size) => {
    const row = custom[size] || templateRow(type, size) || [];
    return t.columns.map((_, i) => (i === 0 ? size : String(row[i] ?? "")));
  });
}

/** Таблица размеров товара: { type, columns, rows, measure } или null — у товара её нет */
export function sizeChartFor(product) {
  const saved = state.sizeCharts?.[product.id];
  const type = saved?.type || guessChartType(product);
  if (!CHART_TYPES[type]) return null;
  const rows = chartRows(product, type, saved?.rows);
  // ни одной заполненной ячейки — показывать нечего
  if (!rows.some((row) => row.slice(1).some(Boolean))) return null;
  return { type, columns: CHART_TYPES[type].columns, rows, measure: CHART_TYPES[type].measure };
}

/** Число или диапазон «94–97» → [от, до] */
function bounds(cell) {
  const nums = String(cell).replace(",", ".").match(/\d+(\.\d+)?/g)?.map(Number);
  return nums?.length ? [nums[0], nums[nums.length - 1]] : null;
}

/** Подходящий размер по мерке: первая строка, в которую мерка помещается (или следующая, если попала между строками) */
export function suggestSize(chart, value) {
  const v = Number(String(value).replace(",", "."));
  if (!(v > 0)) return null;
  const rows = chart.rows.map((row) => [row, bounds(row[chart.measure.column])]).filter(([, b]) => b);
  if (!rows.length) return null;
  const min = Math.min(...rows.map(([, b]) => b[0])), max = Math.max(...rows.map(([, b]) => b[1]));
  if (v < min - 4) return { tooSmall: true };
  if (v > max + (chart.type === "shoes" ? 0.5 : 4)) return { tooBig: true };
  const fit = rows.find(([, [, to]]) => v <= to + (chart.type === "shoes" ? 0.2 : 0.5)) || rows[rows.length - 1];
  return { size: fit[0][0] };
}

/** Кнопка «Таблица размеров» и раскрывающаяся панель под выбором размера */
export function sizeChartHtml(product) {
  const chart = sizeChartFor(product);
  if (!chart) return "";
  return `<button class="sc-open" id="sizeChartToggle" aria-expanded="false" aria-controls="sizeChart">Таблица размеров</button>
    <section class="sc" id="sizeChart" hidden>
      <div class="sc-wrap"><table class="sc-tab">
        <thead><tr>${chart.columns.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead>
        <tbody>${chart.rows.map((row) => `<tr data-chart-size="${row[0]}">${row.map((cell, i) =>
          i === 0 ? `<th scope="row">${cell}</th>` : `<td>${escapeHtml(cell) || "—"}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <p class="sc-note">Нажмите на строку, чтобы выбрать размер. Если мерки между размерами — берите больший.</p>
      <label class="sc-find"><span>Подобрать размер: ${chart.measure.label.toLowerCase()}</span>
        <input id="sizeFinder" type="number" inputmode="decimal" min="0" step="0.5" placeholder="${chart.measure.placeholder}"></label>
      <p class="sc-result" id="sizeFinderResult"></p>
      <details class="sc-how"><summary>Как снять мерки</summary><p>${HOW_TO_MEASURE[chart.type]}</p></details>
    </section>`;
}

/** Подсветка выбранного и недоступных размеров в таблице */
export function syncSizeChart(selectedSize, isUnavailable) {
  document.querySelectorAll("[data-chart-size]").forEach((row) => {
    row.classList.toggle("on", row.dataset.chartSize === selectedSize);
    row.classList.toggle("off", isUnavailable(row.dataset.chartSize));
  });
}

/** Подсказка по мерке: { text, size } — size есть, если размер нашёлся */
export function finderResult(product, value) {
  const chart = sizeChartFor(product);
  const fit = chart && suggestSize(chart, value);
  if (!fit) return { text: "" };
  if (fit.tooSmall) return { text: "Меньше самого маленького размера в таблице" };
  if (fit.tooBig) return { text: "Больше самого большого размера в таблице" };
  return { text: `Вам подойдёт размер ${fit.size}`, size: fit.size };
}
