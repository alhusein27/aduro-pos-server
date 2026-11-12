  var KEY_NAME = 'aduroPosAdminKey';
  var adminKey = '';
  try { adminKey = sessionStorage.getItem(KEY_NAME) || ''; } catch (e) { adminKey = ''; }

  function el(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(pesewas) {
    var value = Number(pesewas);
    if (!Number.isFinite(value)) value = 0;
    var sign = value < 0 ? '-' : '';
    var abs = Math.abs(Math.round(value));
    var cedis = Math.floor(abs / 100);
    var rest = abs % 100;
    var grouped = String(cedis).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + 'GH₵' + grouped + '.' + (rest < 10 ? '0' : '') + rest;
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function formatSeen(iso) {
    if (!iso) return 'Not seen yet';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Not seen yet';
    var time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
    return formatDate(iso) + ', ' + time;
  }

  function showView(name) {
    el('viewSignin').classList.toggle('hidden', name !== 'signin');
    el('viewShops').classList.toggle('hidden', name !== 'shops');
    el('viewDetail').classList.toggle('hidden', name !== 'detail');
  }

  function showError(id, message) {
    var box = el(id);
    if (message) {
      box.textContent = message;
      box.classList.remove('hidden');
    } else {
      box.textContent = '';
      box.classList.add('hidden');
    }
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'x-admin-key': adminKey };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) {
            var err = new Error(json && json.error ? json.error : 'Something went wrong. Please try again.');
            err.status = res.status;
            throw err;
          }
          return json;
        });
      });
  }

  function backToSignin(message) {
    adminKey = '';
    try { sessionStorage.removeItem(KEY_NAME); } catch (e) {}
    el('adminKeyInput').value = '';
    showError('signinError', message || '');
    showView('signin');
  }

  function renderShops(shops) {
    var list = el('shopList');
    list.innerHTML = '';
    if (!shops || shops.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'card';
      empty.innerHTML = '<p>No shops yet. Create the first shop with the form above.</p>';
      list.appendChild(empty);
      return;
    }
    shops.forEach(function (shop) {
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<h3>' + esc(shop.name) + '</h3>' +
        '<p class="meta">Town: ' + esc(shop.town || 'Not given') + '<br>' +
        'Shop code: <strong>' + esc(shop.code) + '</strong><br>' +
        'Owner: ' + esc(shop.ownerName) + '<br>' +
        'Devices: ' + esc(shop.deviceCount) + ' &nbsp; Sales: ' + esc(shop.salesCount) + '<br>' +
        'Created: ' + esc(formatDate(shop.createdAt)) + '</p>' +
        '<p><button type="button" class="btn-navy" data-view-shop="' + esc(shop.id) + '">View</button></p>';
      list.appendChild(card);
    });
  }

  function loadShops() {
    showError('shopsError', '');
    return api('/admin/api/shops').then(function (data) {
      renderShops(data.shops);
    }).catch(function (err) {
      if (err.status === 401 || err.status === 503) {
        backToSignin(err.message);
      } else {
        showError('shopsError', err.message);
      }
    });
  }

  function showCreated(created, shopName) {
    el('createdCode').textContent = created.shopCode;
    el('createdToken').textContent = created.ownerToken;
    var message = 'Your Aduro POS shop is ready.\n'
      + 'Shop name: ' + shopName + '\n'
      + 'Shop code: ' + created.shopCode + '\n'
      + 'Owner token: ' + created.ownerToken + '\n'
      + 'Keep the owner token private. Do not share it with anyone else.';
    el('waLink').href = 'https://wa.me/?text=' + encodeURIComponent(message);
    el('createdPanel').classList.remove('hidden');
    el('createdPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function copyText(text, button) {
    function done() {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function renderDetail(data) {
    var shop = data.shop;
    el('detailName').textContent = shop.name;
    el('detailName').setAttribute('data-shop-id', shop.id);
    el('detailMeta').innerHTML =
      'Town: ' + esc(shop.town || 'Not given') + '<br>' +
      'Shop code: <strong>' + esc(shop.code) + '</strong><br>' +
      'Owner: ' + esc(shop.ownerName) + '<br>' +
      'Created: ' + esc(formatDate(shop.createdAt)) + '<br>' +
      'Devices: ' + esc(shop.deviceCount) + ' &nbsp; Sales: ' + esc(shop.salesCount);

    var devicesBox = el('detailDevices');
    if (!data.devices || data.devices.length === 0) {
      devicesBox.innerHTML = '<p>No devices linked yet.</p>';
    } else {
      devicesBox.innerHTML = data.devices.map(function (device) {
        return '<div class="line"><strong>' + esc(device.label) + '</strong> (' + esc(device.role) + ')<br>' +
          '<span class="meta">Staff name: ' + esc(device.staffName || 'Not given') + '<br>' +
          'Last seen: ' + esc(formatSeen(device.lastSeenAt)) + '</span><br>' +
          '<button type="button" class="btn-quiet" data-revoke-device="' + esc(device.id) + '">Revoke</button></div>';
      }).join('');
    }

    var t = data.today || {};
    var rows = [
      ['Sales today', t.salesPesewas],
      ['Cash', t.cashPesewas],
      ['MoMo', t.momoPesewas],
      ['Credit', t.creditPesewas],
      ['Profit', t.profitPesewas]
    ];
    el('detailToday').innerHTML = rows.map(function (row) {
      return '<div class="stat"><span>' + esc(row[0]) + '</span><span class="money">' + esc(formatMoney(row[1])) + '</span></div>';
    }).join('') + '<p class="meta">Number of sales today: ' + esc(t.saleCount || 0) + '</p>';

    el('detailPending').innerHTML = '<p>The credit book stays on the shop till in this version. Only sales come up to this server.</p>';

    var salesBox = el('detailSales');
    if (!data.recentSales || data.recentSales.length === 0) {
      salesBox.innerHTML = '<p>No sales yet</p>';
    } else {
      salesBox.innerHTML = data.recentSales.map(function (sale) {
        return '<div class="line"><strong>' + esc(sale.id || '') + '</strong> ' +
          '<span class="money">' + esc(formatMoney(sale.totalPesewas)) + '</span><br>' +
          '<span class="meta">' + esc(sale.attendant || '') + ', ' +
          esc(sale.tender || '') + ', ' + esc(formatDate(sale.createdAt)) + '</span></div>';
      }).join('');
    }
  }

  function openShop(id) {
    showError('detailError', '');
    api('/admin/api/shops/' + encodeURIComponent(id)).then(function (data) {
      renderDetail(data);
      showView('detail');
      window.scrollTo(0, 0);
    }).catch(function (err) {
      if (err.status === 401 || err.status === 503) {
        backToSignin(err.message);
      } else {
        showError('shopsError', err.message);
        showView('shops');
      }
    });
  }

  el('signinForm').addEventListener('submit', function (event) {
    event.preventDefault();
    showError('signinError', '');
    adminKey = el('adminKeyInput').value.trim();
    if (!adminKey) {
      showError('signinError', 'Please type the admin key.');
      return;
    }
    api('/admin/api/shops').then(function (data) {
      try { sessionStorage.setItem(KEY_NAME, adminKey); } catch (e) {}
      renderShops(data.shops);
      showView('shops');
    }).catch(function (err) {
      adminKey = '';
      showError('signinError', err.message);
    });
  });

  el('createForm').addEventListener('submit', function (event) {
    event.preventDefault();
    showError('shopsError', '');
    var name = el('shopNameInput').value.trim();
    var town = el('shopTownInput').value.trim();
    var ownerName = el('ownerNameInput').value.trim();
    api('/admin/shops', {
      method: 'POST',
      body: JSON.stringify({ name: name, town: town, ownerName: ownerName })
    }).then(function (created) {
      el('createForm').reset();
      showCreated(created, name);
      return loadShops();
    }).catch(function (err) {
      if (err.status === 401 || err.status === 503) {
        backToSignin(err.message);
      } else {
        showError('shopsError', err.message);
      }
    });
  });

  el('copyCodeBtn').addEventListener('click', function () {
    copyText(el('createdCode').textContent, el('copyCodeBtn'));
  });
  el('copyTokenBtn').addEventListener('click', function () {
    copyText(el('createdToken').textContent, el('copyTokenBtn'));
  });
  el('closeCreatedBtn').addEventListener('click', function () {
    var ok = window.confirm('Close this panel? The owner token cannot be seen again after closing. Make sure you have saved it or sent it to the owner.');
    if (ok) el('createdPanel').classList.add('hidden');
  });

  el('refreshBtn').addEventListener('click', function () { loadShops(); });
  el('logoutBtn').addEventListener('click', function () { backToSignin(''); });
  el('backBtn').addEventListener('click', function () {
    showView('shops');
    loadShops();
  });
  el('shopList').addEventListener('click', function (event) {
    var button = event.target.closest('[data-view-shop]');
    if (button) openShop(button.getAttribute('data-view-shop'));
  });

  el('detailDevices').addEventListener('click', function (event) {
    var button = event.target.closest('[data-revoke-device]');
    if (!button) return;
    var deviceId = button.getAttribute('data-revoke-device');
    var ok = window.confirm('Remove this device from the shop? It will stop syncing at once and must be linked again to come back.');
    if (!ok) return;
    api('/admin/api/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' }).then(function () {
      openShop(el('detailName').getAttribute('data-shop-id'));
    }).catch(function (err) {
      if (err.status === 401 || err.status === 503) {
        backToSignin(err.message);
      } else {
        showError('detailError', err.message);
      }
    });
  });

  if (adminKey) {
    api('/admin/api/shops').then(function (data) {
      renderShops(data.shops);
      showView('shops');
    }).catch(function () {
      adminKey = '';
      try { sessionStorage.removeItem(KEY_NAME); } catch (e) {}
      showView('signin');
    });
  }
