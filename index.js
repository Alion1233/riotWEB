function showPage(id, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('page-' + id).classList.add('active');
    btn.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openModal(name, coins, price) {
    document.getElementById('modal-pkg-name').textContent = 'Pakiet ' + name;
    document.getElementById('modal-pkg-coins').textContent = coins;
    document.getElementById('modal-pkg-price').textContent = price;
    document.getElementById('modal').classList.add('open');
  }

  function closeModal() {
    document.getElementById('modal').classList.remove('open');
  }

  function closeModalOutside(e) {
    if (e.target === document.getElementById('modal')) closeModal();
  }