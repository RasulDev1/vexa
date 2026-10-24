// Витрина: категории, сетка товаров, карточка товара, добавление в корзину.
import { $, formatPrice, haptic, toast, on, replayAnimation, reducedMotion } from "./core.js?v=20261001b";
import { CATEGORIES } from "./data.js?v=20261001b";
import { state, saveCart, findProduct } from "./state.js?v=20261001b";
import { colorName, swatchBackground, stockLeft, isUnavailable, isSoldOut } from "./catalog.js?v=20261001b";
import { productImage, swapImage, photoForColor } from "./photos.js?v=20261001b";
import { sheetBody, openSheet, closeSheet, syncMainButton } from "./nav.js?v=20261001b";
import { openCheckout } from "./cart.js?v=20261001b";
import { sizeChartHtml, syncSizeChart } from "./size-chart.js?v=20261001b";
import { loadRatings, ratingHtml, ratingLineHtml, showProductReviews, handleReviewTap } from "./reviews.js?v=20261001b";

const tint = (color) => `color-mix(in srgb, ${color} 14%, var(--bg))`;
const priceHtml = (p) => `<b>${formatPrice(p.price)}</b>${p.oldPrice ? `<s>${formatPrice(p.oldPrice)}</s>` : ""}`;

function badgeHtml(p) {
  if (isSoldOut(p)) return `<span class="badge out">Нет в наличии</span>`;
  if (p.oldPrice) return `<span class="badge">−${Math.round((1 - p.price / p.oldPrice) * 100)}%</span>`;
  return p.isNew ? `<span class="badge">Новинка</span>` : "";
}

export function renderCategories() {
  $("categories").innerHTML = CATEGORIES.map(([id, title]) =>
    `<button class="chip" data-category="${id}" aria-pressed="${id === state.category}">${title}</button>`).join("");
}

export function renderGrid() {
  const list = state.products.filter((p) => p.category === state.category);
  $("grid").innerHTML = list.map((p, i) => `
    <article class="card${isSoldOut(p) ? " sold" : ""}" data-open="${p.id}">
      <button class="pic" style="background:${tint(p.colors[0])}" aria-label="${p.name}">
        ${productImage(p, null, { thumb: true, lazy: i > 3 })}${badgeHtml(p)}
      </button>
      <p class="name">${p.name}</p>
      <p class="cost">${priceHtml(p)}</p>
      ${ratingHtml(p.id)}
    </article>`).join("") || `<p class="empty">В этой категории пока пусто</p>`;
}

/* ---------- Карточка товара ---------- */
let selected = {}; // { id, color, size }

function stockNote(product, color, size) {
  if (!product.stock) return "";
  if (product.sizes.every((s) => isUnavailable(product, color, s))) return "Этого цвета сейчас нет в наличии";
  const left = size ? stockLeft(product, color, size) : Infinity;
  return left <= 5 ? `Осталось ${left} шт.` : "";
}

/** Карточка товара; writeReview — сразу открыть форму отзыва (кнопка «Оставить отзыв» в «Мои заказы») */
export function openProduct(id, writeReview = false) {
  const p = findProduct(id);
  if (!p) return;
  const onlySize = p.sizes.length === 1 && !isUnavailable(p, p.colors[0], p.sizes[0]) ? p.sizes[0] : null;
  selected = { id, color: p.colors[0], size: onlySize };

  sheetBody.innerHTML = `<div class="grab"></div>
    <div class="p-pic" id="productPhoto" style="background:${tint(p.colors[0])}">
      ${productImage(p, p.colors[0])}${p.photoAuthor ? `<span class="credit">Фото: ${p.photoAuthor} / Pexels</span>` : ""}
    </div>
    <h2 class="p-name">${p.name}</h2>
    <p class="p-price cost">${priceHtml(p)}</p>
    ${ratingLineHtml(p.id)}
    <p class="p-desc">${p.description}</p>
    <p class="label">Цвет: <span id="colorLabel">${colorName(p, p.colors[0])}</span></p>
    <div class="opts" id="swatches">${p.colors.map((c) => `<button class="swatch" data-color="${c}" style="background:${swatchBackground(p, c)}"
      aria-pressed="${c === p.colors[0]}" aria-label="${colorName(p, c)}" title="${colorName(p, c)}"></button>`).join("")}</div>
    <p class="label">Размер</p>
    <div class="opts" id="sizes">${p.sizes.map((s) => `<button class="size" data-size="${s}" aria-pressed="${s === onlySize}"
      ${isUnavailable(p, p.colors[0], s) ? "disabled" : ""}>${s}</button>`).join("")}</div>
    ${sizeChartHtml(p)}
    <p class="left" id="stockNote">${stockNote(p, p.colors[0], onlySize)}</p>
    <p class="hint" id="hint"></p>
    <div class="buy-row">
      <button class="ghost to-cart" id="addToCart">В корзину</button>
      <button class="primary buy" id="buyNow">Купить · ${formatPrice(p.price)}</button>
    </div>
    <section class="rv" id="reviews"></section>`;

  sheetBody.onclick = (e) => {
    if (handleReviewTap(e)) return;
    const color = e.target.closest("[data-color]")?.dataset.color;
    const size = e.target.closest("[data-size]:not(:disabled)")?.dataset.size;
    if (color) { haptic(); selectColor(p, color); }
    if (size) { haptic(); selectSize(p, size); }
    if (e.target.id === "addToCart") addSelectedToCart();
    if (e.target.id === "buyNow") buySelectedNow();
    if (e.target.id === "sizeChartToggle") toggleSizeChart(p);
    const row = e.target.closest("[data-chart-size]:not(.off)")?.dataset.chartSize;
    if (row && !isUnavailable(p, selected.color, row)) { haptic(); selectSize(p, row); }
  };
  sheetBody.oninput = null;
  openSheet("product");
  showProductReviews(id, writeReview);
}

/** Назад из оформления «Купить»: карточка с тем же цветом и размером */
export function reopenProduct({ id, color, size }) {
  openProduct(id);
  const p = findProduct(id);
  if (!p) return;
  if (p.colors.includes(color)) selectColor(p, color);
  if (p.sizes.includes(size) && !isUnavailable(p, selected.color, size)) selectSize(p, size);
}

/* ---------- Таблица размеров ---------- */
const syncChart = (p) => syncSizeChart(selected.size, (size) => isUnavailable(p, selected.color, size));

function toggleSizeChart(p) {
  const panel = $("sizeChart"), open = panel.hidden;
  haptic();
  panel.hidden = !open;
  $("sizeChartToggle").setAttribute("aria-expanded", open);
  if (open) { syncChart(p); replayAnimation(panel, "swap"); }
}

function selectColor(p, color) {
  selected.color = color;
  sheetBody.querySelectorAll("[data-color]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.color === color));
  sheetBody.querySelectorAll("[data-size]").forEach((b) => {
    b.disabled = isUnavailable(p, color, b.dataset.size);
    if (b.disabled && selected.size === b.dataset.size) { selected.size = null; b.setAttribute("aria-pressed", false); }
  });
  $("colorLabel").textContent = colorName(p, color);
  syncChart(p);
  $("stockNote").textContent = stockNote(p, color, selected.size);
  const frame = $("productPhoto");
  frame.style.background = tint(color);
  photoForColor(p, color).then((url) => selected.color === color && swapImage(frame.querySelector("img"), url));
}

function selectSize(p, size) {
  selected.size = size;
  sheetBody.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.size === size));
  $("stockNote").textContent = stockNote(p, selected.color, size);
  $("hint").textContent = "";
  syncChart(p);
}

/** Размер не выбран — подсказываем и не пускаем дальше */
function sizeMissing() {
  if (selected.size) return false;
  $("hint").textContent = "Выберите размер";
  replayAnimation($("sizes"), "shake");
  haptic("medium");
  return true;
}

/** «Купить»: сразу оформление заказа только этого товара, корзина не меняется */
export function buySelectedNow() {
  if (sizeMissing()) return;
  const { id, color, size } = selected;
  haptic();
  openCheckout({ id, color, size, qty: 1 });
}

export function addSelectedToCart() {
  const p = findProduct(selected.id);
  const { color, size } = selected;
  if (sizeMissing()) return;
  const line = state.cart.find((l) => l.id === p.id && l.color === color && l.size === size);
  if ((line?.qty || 0) >= stockLeft(p, color, size)) {
    $("hint").textContent = `В наличии ${stockLeft(p, color, size)} шт., все уже в корзине`;
    return haptic("medium");
  }
  line ? line.qty++ : state.cart.push({ id: p.id, color, size, qty: 1 });
  saveCart();
  haptic("success");
  const photo = $("productPhoto").querySelector("img");
  const from = photo.getBoundingClientRect();
  closeSheet();
  flyToCart(photo, from);
}

/** Фото товара улетает в корзину */
function flyToCart(photo, fromRect) {
  const bar = $("cartBar"), cartTab = document.querySelector('[data-tab="cart"]');
  const targetRect = (bar.classList.contains("show") ? $("cartBarButton") : cartTab).getBoundingClientRect();
  if (reducedMotion || targetRect.bottom <= 0) return toast("Добавлено в корзину");
  let from = fromRect, target = targetRect;
  const flyer = Object.assign(document.createElement("div"), { className: "flyer" });
  flyer.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px`;
  flyer.innerHTML = `<img src="${photo.src}" alt="" style="object-position:${photo.style.objectPosition}">`;
  document.body.append(flyer);
  // магазин может быть масштабирован под экран (main.js): переводим координаты экрана в координаты страницы
  const k = flyer.getBoundingClientRect().width / from.width || 1;
  if (Math.abs(k - 1) > 0.01) {
    const scale = (r) => ({ left: r.left / k, top: r.top / k, width: r.width / k, height: r.height / k });
    from = scale(from); target = scale(target);
    flyer.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px`;
  }
  const dx = target.left + 28 - from.left - from.width / 2, dy = target.top + target.height / 2 - from.top - from.height / 2;
  flyer.animate([
    { transform: "none", borderRadius: "16px" },
    { transform: `translate(${dx * 0.55}px,${dy * 0.35}px) scale(.42)`, borderRadius: "40px", offset: 0.55 },
    { transform: `translate(${dx}px,${dy}px) scale(.08)`, opacity: 0.6, borderRadius: "200px" },
  ], { duration: 620, easing: "cubic-bezier(.45,0,.2,1)" }).onfinish = () => {
    flyer.remove();
    replayAnimation(cartTab, "bump");
    replayAnimation($("cartBarButton"), "bump");
  };
}

export function initShop() {
  $("categories").onclick = (e) => {
    const category = e.target.closest("[data-category]")?.dataset.category;
    if (!category || category === state.category) return;
    state.category = category;
    haptic();
    renderCategories();
    renderGrid();
    replayAnimation($("grid"), "swap");
  };
  $("grid").onclick = (e) => {
    const id = e.target.closest("[data-open]")?.dataset.open;
    if (!id) return;
    // сотрудник нажатием открывает правку товара, покупатель — карточку товара
    if (state.isAdmin && state.editProduct && document.documentElement.classList.contains("staff-mode")) state.editProduct(Number(id));
    else openProduct(Number(id));
  };
  on("ratings", renderGrid);
  loadRatings();
  on("catalog", () => {
    renderCategories();
    renderGrid();
    if (state.view === "product" && !findProduct(selected.id)) closeSheet();
    syncMainButton();
  });
}
