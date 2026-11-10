/* Progressive enhancement — every page works without JS; this adds live checks & niceties. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH');

  document.addEventListener('DOMContentLoaded', () => {
    // phones: tables turn into stacked cards — give each cell its column name
    $$('table.table:not(.no-stack)').forEach((t) => {
      const heads = $$('thead th', t).map((th) => th.textContent.trim());
      if (!heads.length) return;
      $$('tbody tr', t).forEach((tr) => {
        let col = 0;
        Array.from(tr.children).forEach((td) => {
          if (heads[col] && !td.hasAttribute('data-label') && td.colSpan === 1) td.setAttribute('data-label', heads[col]);
          col += td.colSpan || 1;
        });
      });
    });
    // iOS placeholder for empty date inputs
    $$('.date-wrap input').forEach((i) => { const sync = () => i.toggleAttribute('data-empty', !i.value); i.addEventListener('input', sync); i.addEventListener('change', sync); sync(); });
    // explanations that are open on desktop but folded on phones
    if (window.matchMedia('(min-width: 761px)').matches) $$('details[data-open-wide]').forEach((d) => { d.open = true; });
    // admin sidebar: tap outside to close
    const backdrop = $('.sidebar-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => { const sb = $('#sidebar'); if (sb) sb.classList.remove('open'); });

    // toggles (mobile menu, admin sidebar)
    $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => { const t = $(b.dataset.toggle); if (t) t.classList.toggle('open'); }));
    $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
    $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!window.confirm(f.dataset.confirm)) e.preventDefault(); }));
    $$('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,form,input,select')) location.href = tr.dataset.href; }));
    $$('[data-open-dialog]').forEach((b) => b.addEventListener('click', () => { const d = $(b.dataset.openDialog); if (d && d.showModal) d.showModal(); }));
    $$('[data-add-row]').forEach((b) => b.addEventListener('click', () => {
      const tb = $(b.dataset.addRow); const last = tb && tb.lastElementChild; if (!last) return;
      const row = last.cloneNode(true); $$('input', row).forEach((i) => { i.value = i.dataset.default || ''; });
      tb.appendChild(row); const first = $('input', row); if (first) first.focus();
    }));
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-row]'); if (!b) return;
      const tr = b.closest('tr'); const tb = tr.parentElement;
      if (tb.children.length > 1) tr.remove(); else $$('input', tr).forEach((i) => { i.value = ''; });
    });
    // "Freesize" toggles next to measurement inputs (admin form + catalog filter): checked → number inputs off
    $$('[data-fs]').forEach((cb) => {
      const wrap = cb.closest('[data-fs-wrap]');
      const inputs = wrap ? $$('input[type=number]', wrap) : [];
      const sync = () => inputs.forEach((i) => {
        i.disabled = cb.checked;
        if (cb.checked) { i.dataset.ph = i.dataset.ph || i.placeholder; i.placeholder = 'Freesize'; i.value = ''; } else if (i.dataset.ph) i.placeholder = i.dataset.ph;
      });
      cb.addEventListener('change', sync); sync();
    });
    $$('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

    // product page gallery: arrows, thumbnails, keyboard ← →, swipe
    const g = $('[data-gallery]');
    const stage = g && $('[data-stage]', g);
    if (stage) {
      const imgs = $$('img', stage); const thumbs = $$('.thumbs button', g); const count = $('[data-count]', g);
      let cur = 0;
      const go = (k) => {
        k = (k + imgs.length) % imgs.length; if (k === cur) return;
        imgs[cur].classList.remove('is-active'); imgs[k].classList.add('is-active');
        thumbs.forEach((t, j) => t.classList.toggle('active', j === k));
        if (thumbs[k]) thumbs[k].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        cur = k; if (count) count.textContent = `${k + 1} / ${imgs.length}`;
      };
      $$('.g-nav', g).forEach((b) => b.addEventListener('click', () => go(cur + Number(b.dataset.step))));
      thumbs.forEach((t) => t.addEventListener('click', () => go(Number(t.dataset.index))));
      document.addEventListener('keydown', (e) => {
        if (e.target.closest('input,select,textarea')) return;
        if (e.key === 'ArrowLeft') go(cur - 1); else if (e.key === 'ArrowRight') go(cur + 1);
      });
      let x0 = null;
      stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
        if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1));
      });
    }

    // qty steppers
    $$('[data-qty]').forEach((q) => {
      const input = $('input', q);
      $$('button', q).forEach((b) => b.addEventListener('click', () => {
        input.value = Math.max(1, Math.min(Number(input.max || 99), (parseInt(input.value, 10) || 1) + Number(b.dataset.step)));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }));
    });

    // countdown
    $$('[data-countdown]').forEach((el) => {
      const end = Number(el.dataset.countdown);
      const tick = () => {
        const s = Math.max(0, Math.floor((end - Date.now()) / 1000));
        const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
        el.textContent = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
        if (s === 0) { el.textContent = 'หมดเวลา'; clearInterval(t); setTimeout(() => location.reload(), 1500); }
      };
      const t = setInterval(tick, 1000); tick();
    });

    // file attach feedback: file name, size, preview, type/size validation
    $$('input[type=file]').forEach(setupFileInput);
    // forms with a "busy" button: show progress state, prevent double submit
    $$('form').filter((f) => f.enctype === 'multipart/form-data' || $('button[data-busy]', f)).forEach((f) => f.addEventListener('submit', (e) => {
      if (e.defaultPrevented) return;
      const bad = $$('input[type=file]', f).some((i) => i.dataset.invalid === '1');
      if (bad) { e.preventDefault(); window.alert('ไฟล์ที่แนบไม่ถูกต้อง กรุณาเลือกใหม่'); return; }
      const b = $('button[data-busy]', f) || e.submitter;
      if (b && b.dataset.busy) { b.textContent = b.dataset.busy; b.classList.add('busy'); }
    }));

    // checkout: live shipping fee
    const total = $('[data-total]');
    if (total) {
      const upd = () => {
        const r = $('input[name=shipping_method]:checked'); if (!r) return;
        const fee = Number(r.dataset.fee || 0);
        $('[data-ship-fee]').textContent = r.value === 'express' ? 'ตามจริง' : baht(fee);
        total.textContent = baht(Number(total.dataset.subtotal) + fee);
      };
      $$('input[name=shipping_method]').forEach((r) => r.addEventListener('change', upd));
    }

    // dependent fields: data-show-if="fieldName=value"
    const deps = $$('[data-show-if]');
    if (deps.length) {
      const sync = () => deps.forEach((el) => {
        const [name, val] = el.dataset.showIf.split('=');
        const ctl = $$(`[name="${name}"]`);
        const cur = ctl.length && ctl[0].type === 'radio' ? (ctl.find((r) => r.checked) || {}).value : (ctl[0] || {}).value;
        el.hidden = cur !== val;
      });
      document.addEventListener('change', sync); sync();
    }

    // checkout: cascading Thai address dropdowns (จังหวัด → เขต/อำเภอ → แขวง/ตำบล → รหัสไปรษณีย์)
    if ($('[data-addr=province]')) setupAddress();

    // catalog: rotate product photos (staggered per card, only while visible, paused on reduced motion)
    setupSlides();

    // product page booking box
    const book = $('#book');
    if (book) setupBooking(book);
  });

  /** Catalog cards: first photo at rest; while hovered, cycle through every photo; back to the first on leave. */
  function setupSlides() {
    const INTERVAL = 1300;
    // Phones have no hover: the card in the middle of the screen plays instead, and a sideways swipe flips photos.
    const touchMode = window.matchMedia('(hover: none)').matches;
    const decks = [];
    $$('[data-slides]').forEach((deck) => {
      const imgs = $$('img', deck);
      if (imgs.length < 2) return;
      const dots = $$('.slide-dots span', deck.parentElement);
      const card = deck.closest('.product-card') || deck;
      let i = 0; let timer = null;
      const show = (k) => {
        imgs[i].classList.remove('is-active'); if (dots[i]) dots[i].classList.remove('on');
        i = (k + imgs.length) % imgs.length;
        imgs[i].classList.add('is-active'); if (dots[i]) dots[i].classList.add('on');
      };
      const tick = () => show(i + 1);
      const start = () => {
        if (timer) return;
        imgs.forEach((im) => { im.loading = 'eager'; }); // preload the rest on first play
        tick();
        timer = setInterval(tick, INTERVAL);
      };
      const stop = () => { clearInterval(timer); timer = null; if (i !== 0) show(0); };
      const restart = () => { clearInterval(timer); timer = setInterval(tick, INTERVAL); };
      decks.push({ card, start, stop });

      if (!touchMode) {
        card.addEventListener('mouseenter', start);
        card.addEventListener('mouseleave', stop);
        card.addEventListener('focusin', start);
        card.addEventListener('focusout', stop);
        return;
      }
      // swipe left/right on the photo → previous/next (and don't open the product)
      let x0 = null; let y0 = 0; let swiped = false;
      deck.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; swiped = false; }, { passive: true });
      deck.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0; const dy = e.changedTouches[0].clientY - y0; x0 = null;
        if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          swiped = true; imgs.forEach((im) => { im.loading = 'eager'; });
          show(dx < 0 ? i + 1 : i - 1); if (timer) restart();
        }
      }, { passive: true });
      card.addEventListener('click', (e) => { if (swiped) { e.preventDefault(); swiped = false; } });
    });

    if (touchMode && decks.length && 'IntersectionObserver' in window) {
      // "hover" on phones = the card sitting in the middle band of the screen
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          const d = decks.find((x) => x.card === en.target);
          if (d) (en.isIntersecting ? d.start : d.stop)();
        });
      }, { rootMargin: '-30% 0px -30% 0px', threshold: 0 });
      decks.forEach((d) => io.observe(d.card));
    }
  }

  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function setupFileInput(input) {
    const zone = input.closest('[data-dropzone]');
    const host = zone || input.parentElement;
    const oldPreview = zone && $('img.preview', zone); if (oldPreview) oldPreview.remove();
    const status = document.createElement('div'); status.className = 'file-status'; status.hidden = true; status.setAttribute('aria-live', 'polite');
    const previews = document.createElement('div'); previews.className = 'file-previews';
    host.appendChild(status); host.appendChild(previews);
    const maxMb = Number(input.dataset.maxMb || 10);
    const maxFiles = input.multiple ? 12 : 1;
    const okTypes = (input.accept || 'image/').split(',').map((t) => t.trim());
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let selected = [];

    const setFiles = (files) => {
      selected = files.slice(0, maxFiles);
      const dt = new DataTransfer();
      selected.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      render();
    };
    // clicks on our buttons must not open the file picker (they sit inside the <label>)
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    function render() {
      previews.innerHTML = '';
      if (zone) zone.classList.remove('has-file', 'has-error');
      if (!selected.length) { status.hidden = true; input.dataset.invalid = ''; return; }
      const errors = [];
      selected.forEach((f) => {
        if (!okTypes.some((t) => (t.endsWith('/') ? f.type.startsWith(t) : f.type === t))) errors.push(`${f.name}: ไม่ใช่ไฟล์รูปที่รองรับ (JPG, PNG, WEBP)`);
        else if (f.size > maxMb * 1048576) errors.push(`${f.name}: ขนาด ${fmtSize(f.size)} เกินกำหนด ${maxMb} MB`);
      });
      input.dataset.invalid = errors.length ? '1' : '';
      status.hidden = false;
      const total = selected.reduce((a, f) => a + f.size, 0);
      if (errors.length) {
        status.className = 'file-status bad';
        status.innerHTML = '✕ มีไฟล์ที่ใช้ไม่ได้ — กด × เพื่อลบไฟล์นั้นออก<ul>' + errors.map((m) => `<li>${esc(m)}</li>`).join('') + '</ul>';
        if (zone) zone.classList.add('has-error');
      } else {
        status.className = 'file-status ok';
        status.innerHTML = selected.length === 1
          ? `✓ แนบรูปแล้ว: <strong>${esc(selected[0].name)}</strong> (${fmtSize(selected[0].size)})`
          : `✓ แนบรูปแล้ว <strong>${selected.length} รูป</strong> (รวม ${fmtSize(total)})`;
        status.innerHTML += input.multiple ? ' · กดกรอบเพื่อเพิ่มรูป · กด × เพื่อลบ' : ' · กด × เพื่อลบ หรือกดกรอบเพื่อเปลี่ยนรูป';
        if (zone) zone.classList.add('has-file');
      }
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'btn sm ghost file-clear'; clear.textContent = selected.length > 1 ? 'ล้างทั้งหมด' : 'ลบรูปนี้';
      clear.addEventListener('click', (e) => { stop(e); setFiles([]); });
      status.appendChild(clear);
      selected.forEach((f, i) => {
        const item = document.createElement('div'); item.className = 'fp';
        const ok = okTypes.some((t) => (t.endsWith('/') ? f.type.startsWith(t) : f.type === t));
        if (ok) { const im = document.createElement('img'); im.alt = f.name; im.src = URL.createObjectURL(f); item.appendChild(im); }
        else { const ph = document.createElement('div'); ph.className = 'fp-bad'; ph.textContent = f.name; item.appendChild(ph); }
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'fp-x'; x.textContent = '×'; x.title = `ลบ ${f.name}`; x.setAttribute('aria-label', `ลบ ${f.name}`);
        x.addEventListener('click', (e) => { stop(e); setFiles(selected.filter((_, j) => j !== i)); });
        item.appendChild(x);
        previews.appendChild(item);
      });
    }

    const key = (f) => `${f.name}|${f.size}|${f.lastModified}`;
    const addFiles = (incoming) => {
      if (!input.multiple) return setFiles(incoming.slice(0, 1));
      const seen = new Set(selected.map(key));
      const merged = selected.concat(incoming.filter((f) => !seen.has(key(f))));
      if (merged.length > maxFiles) window.alert(`แนบได้สูงสุด ${maxFiles} รูปต่อครั้ง`);
      setFiles(merged);
    };
    input.addEventListener('change', () => addFiles(Array.from(input.files || [])));
    if (zone) {
      ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('dragover')));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
      });
    }
  }

  async function setupAddress() {
    const sel = (n) => $(`[data-addr=${n}]`);
    const prov = sel('province'); const dist = sel('district'); const sub = sel('subdistrict'); const zip = sel('postcode');
    let tree;
    try { tree = await fetch('/static/data/th-address.json').then((r) => r.json()); } catch (e) { return; }
    const sortTh = (a) => a.sort((x, y) => x.localeCompare(y, 'th'));
    const fill = (el, items, placeholder) => {
      const keep = el.value;
      el.innerHTML = '';
      el.add(new Option(placeholder, ''));
      items.forEach((v) => el.add(new Option(v, v)));
      el.value = items.includes(keep) ? keep : '';
      if (items.length === 1 && el === zip) el.value = items[0];
      el.disabled = items.length === 0;
    };
    const update = (from) => {
      const p = tree[prov.value] || {};
      if (from <= 0) fill(dist, sortTh(Object.keys(p)), 'เลือกเขต/อำเภอ');
      const d = p[dist.value] || {};
      if (from <= 1) fill(sub, sortTh(Object.keys(d)), 'เลือกแขวง/ตำบล');
      fill(zip, d[sub.value] || [], 'เลือกรหัสไปรษณีย์');
    };
    prov.addEventListener('change', () => update(0));
    dist.addEventListener('change', () => update(1));
    sub.addEventListener('change', () => update(2));
    update(0);
  }

  function setupBooking(form) {
    const box = $('[data-avail]');
    const cal = $('[data-calendar]');
    const submits = $$('[data-submit]', form);
    const sku = () => { const r = $('input[name=sku_id]:checked', form) || $('input[data-sku]', form); return r ? r.value : null; };
    const date = $('input[name=start_date]', form);
    const time = $('select[name=start_time]', form);
    const days = $('select[name=days]', form);
    const qty = $('input[name=qty]', form);
    let calMonth = (date.value || new Date().toISOString().slice(0, 10)).slice(0, 7);
    let seq = 0;

    const setSubmit = (ok) => submits.forEach((b) => { b.disabled = !ok; });

    async function check() {
      const s = sku();
      if (!s || !date.value) { box.className = 'avail-box'; box.textContent = s ? 'เลือกวันเริ่มเช่า เพื่อตรวจสอบว่าชุดว่างหรือไม่' : 'ชุดนี้ยังไม่เปิดให้จอง'; setSubmit(!!s && !!date.value); return; }
      const my = ++seq;
      box.className = 'avail-box'; box.textContent = 'กำลังตรวจสอบ…';
      try {
        const r = await fetch(`/api/availability?sku=${s}&date=${date.value}&time=${encodeURIComponent(time.value)}&days=${days.value}&qty=${parseInt(qty.value, 10) || 1}`).then((x) => x.json());
        if (my !== seq) return;
        if (!r.ok) { box.className = 'avail-box bad'; box.textContent = r.error; setSubmit(false); return; }
        const want = parseInt(qty.value, 10) || 1;
        const enough = r.available >= want;
        box.className = 'avail-box ' + (enough ? 'ok' : r.held ? 'held' : 'bad');
        box.innerHTML = (enough ? `✓ ว่าง <strong>${r.available}</strong> ชิ้นในช่วงนี้` : (r.held ? '🟡 มีผู้จองช่วงนี้แล้ว · รอร้านยืนยันการชำระเงิน — หากไม่ได้รับการยืนยัน ชุดจะว่างอีกครั้ง' : r.available ? `ว่างเพียง <strong>${r.available}</strong> ชิ้น (ต้องการ ${want})` : '✕ ไม่ว่างในช่วงเวลานี้') + (r.nextLabel ? `<br><span class="small">ว่างอีกครั้งประมาณ <strong>${r.nextLabel}</strong> (เช่า ${days.value} วัน)</span>` : ''))
          + `<br><span class="small">เริ่ม ${r.startLabel} → <strong>คืนภายใน ${r.dueLabel}</strong> (${r.hours} ชม.)</span>`
          + `<br><span class="small">ค่าเช่า ${r.listPrice > r.unitPrice ? `<s>${baht(r.listPrice)}</s> ` : ''}${baht(r.unitPrice)} × ${want} = <strong>${baht(r.unitPrice * want)}</strong>${r.promoLabel && r.listPrice > r.unitPrice ? ` <span class="promo-tag">${r.promoLabel}</span>` : ''}</span>`;
        const priceEl = $('[data-price]'); if (priceEl) { priceEl.textContent = baht(r.unitPrice) + ` / ${days.value} วัน`; priceEl.classList.toggle('sale', r.listPrice > r.unitPrice); }
        const was = $('[data-was]'); if (was) { was.textContent = baht(r.listPrice); was.hidden = !(r.listPrice > r.unitPrice); }
        setSubmit(enough);
      } catch (e) { box.textContent = 'ตรวจสอบไม่สำเร็จ กรุณาลองใหม่'; }
    }

    async function renderCal() {
      const s = sku();
      if (!cal) return;
      if (!s) { cal.innerHTML = '<p class="muted small">ชุดนี้ยังไม่เปิดให้จอง</p>'; return; }
      const r = await fetch(`/api/calendar?sku=${s}&month=${calMonth}&days=${days.value}&time=${encodeURIComponent(time.value)}`).then((x) => x.json());
      const [y, m] = r.month.split('-').map(Number);
      const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      let html = `<div class="cal-head"><button type="button" data-m="-1" aria-label="เดือนก่อน">‹</button><strong>${title}</strong><button type="button" data-m="1" aria-label="เดือนถัดไป">›</button></div><div class="cal-grid">`;
      ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].forEach((d) => { html += `<div class="dow">${d}</div>`; });
      for (let i = 0; i < first; i++) html += '<div></div>';
      r.dates.forEach((d) => {
        const n = Number(d.date.slice(8));
        html += `<div class="day ${d.state} ${d.date === date.value ? 'selected' : ''}" data-date="${d.state === 'free' ? d.date : ''}" title="${d.state === 'free' ? 'ว่าง ' + d.available + ' ชิ้น' : d.state === 'full' ? 'เต็ม' : 'ปิดรับจอง'}">${n}${d.state === 'free' ? `<span class="n">${d.available}</span>` : ''}</div>`;
      });
      cal.innerHTML = html + '</div>';
      const note = $('[data-cal-note]'); if (note) note.textContent = `เริ่ม ${r.time} น. · เช่า ${r.days} วัน`;
      $$('[data-m]', cal).forEach((b) => b.addEventListener('click', () => {
        const d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.m), 1));
        calMonth = d.toISOString().slice(0, 7); renderCal();
      }));
      $$('.day[data-date]', cal).forEach((el) => { if (el.dataset.date) el.addEventListener('click', () => { date.value = el.dataset.date; check(); renderCal(); }); });
    }

    form.addEventListener('change', (e) => {
      if (e.target === date && date.value) calMonth = date.value.slice(0, 7);
      check();
      if (e.target !== qty) renderCal();
    });
    check(); renderCal();
  }
})();
