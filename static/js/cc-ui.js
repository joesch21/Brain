(function(){
  // Toasts
  window.Toast = {
    show(type, msg){
      const wrap = document.getElementById('toast-container');
      if(!wrap) return;
      const t = document.createElement('div');
      t.className = `cc-toast cc-toast--${type}`;
      t.textContent = msg;
      wrap.appendChild(t);
      setTimeout(()=> t.remove(), 5000);
    }
  };

  // Responsive nav
  const toggle = document.querySelector('.cc-toolbar__toggle');
  const nav = document.querySelector('.cc-toolbar__nav');
  if(toggle && nav){
    toggle.addEventListener('click', ()=>{
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true':'false');
    });
  }
})();
