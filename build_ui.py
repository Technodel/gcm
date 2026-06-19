import os

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} â€” GCM Galaxy Competitor Monitor</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {{
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --pink: #ec4899;
      --bg: #030712;
      --card: rgba(17, 24, 39, 0.7);
      --card-hover: rgba(31, 41, 55, 0.8);
      --border: rgba(139, 92, 246, 0.15);
      --border-hover: rgba(139, 92, 246, 0.4);
      --txt: #f8fafc;
      --txt2: #94a3b8;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      background: var(--bg);
      font-family: 'Outfit', sans-serif;
      color: var(--txt);
      overflow-x: hidden;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }}
    body::before {{
      content: ''; position: fixed; top: -50%; left: -50%; width: 200%; height: 200%;
      background: radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
                  radial-gradient(circle at 80% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 40%);
      z-index: -1; pointer-events: none;
    }}

    /* NAV */
    nav {{
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 8vw; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      background: rgba(3, 7, 18, 0.6);
      border-bottom: 1px solid var(--border);
    }}
    .nav-logo {{ display: flex; align-items: center; gap: 12px; text-decoration: none; }}
    .nav-logo-img {{
      width: 40px; height: 40px; border-radius: 50%;
      object-fit: cover; object-position: center;
      border: 2px solid rgba(248, 201, 92, 0.5);
      box-shadow: 0 0 16px rgba(248, 201, 92, 0.35);
      flex-shrink: 0;
    }}
    .nav-logo-text-wrap {{ display: flex; flex-direction: column; line-height: 1.1; }}
    .nav-logo-text {{
      font-size: 1.3rem; font-weight: 900;
      background: linear-gradient(135deg, #f8c95c, #fff);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }}
    .nav-logo-sub {{ font-size: 0.65rem; color: var(--txt2); font-weight: 500; letter-spacing: 0.3px; }}
    .nav-links {{ display: flex; align-items: center; gap: 32px; }}
    .nav-links a {{ color: var(--txt2); text-decoration: none; font-size: 0.95rem; font-weight: 500; transition: 0.3s; }}
    .nav-links a:hover {{ color: #fff; text-shadow: 0 0 10px rgba(255,255,255,0.3); }}
    .nav-cta {{
      padding: 10px 24px; border-radius: 10px;
      background: linear-gradient(135deg, var(--blue), var(--purple));
      color: #fff !important; font-weight: 600 !important;
      box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3); transition: 0.3s !important;
    }}
    .nav-cta:hover {{ transform: translateY(-2px); box-shadow: 0 8px 25px rgba(139, 92, 246, 0.5) !important; }}

    /* MAIN */
    main {{ flex: 1; }}

    /* FOOTER */
    footer {{
      padding: 40px 8vw; border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      margin-top: auto;
    }}
    .footer-logo {{ font-size: 1.2rem; font-weight: 800; color: var(--txt2); }}
    .footer-links {{ display: flex; gap: 24px; }}
    .footer-links a {{ color: var(--txt2); text-decoration: none; font-size: 0.9rem; transition: 0.2s; }}
    .footer-links a:hover {{ color: #fff; }}

    {extra_css}

  </style>
</head>
<body>

  <nav>
    <a href="/landing" class="nav-logo">
      <img src="/galaxy.png" alt="Galaxy" class="nav-logo-img">
      <div class="nav-logo-text-wrap">
        <span class="nav-logo-text">GCM</span>
        <span class="nav-logo-sub">Galaxy Competitor Monitor</span>
      </div>
    </a>
    <div class="nav-links">
      <a href="/landing#features">Features</a>
      <a href="/pricing">Pricing</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
      <a href="/login" class="nav-cta">Dashboard</a>
    </div>
  </nav>

  <main>
    {content}
  </main>

  <footer>
    <div class="footer-logo">GCM â€” Galaxy Competitor Monitor</div>
    <div class="footer-links">
      <a href="/landing">Home</a>
      <a href="/pricing">Pricing</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </div>
  </footer>

  <script src="/branding.js"></script>
  {extra_js}
</body>
</html>"""

PAGES = {}

PAGES['landing.html'] = {
    'title': 'Home',
    'extra_css': '''
    .hero { min-height: 85vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 60px 20px; }
    .hero-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 20px; border-radius: 50px; background: rgba(139, 92, 246, 0.1); border: 1px solid var(--border); color: var(--purple); font-weight: 600; font-size: 0.85rem; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 30px; box-shadow: 0 0 20px rgba(139,92,246,0.15); }
    .hero h1 { font-size: clamp(3rem, 7vw, 5.5rem); font-weight: 900; line-height: 1.05; max-width: 900px; margin-bottom: 24px; background: linear-gradient(to right, #fff 20%, #cbd5e1 50%, var(--blue) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: clamp(1.1rem, 2vw, 1.3rem); color: var(--txt2); max-width: 650px; line-height: 1.6; margin-bottom: 40px; font-weight: 300; }
    .btn-group { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
    .btn { padding: 16px 36px; border-radius: 12px; font-weight: 600; font-size: 1.1rem; text-decoration: none; transition: 0.3s; display: inline-flex; align-items: center; gap: 10px; }
    .btn-primary { background: linear-gradient(135deg, var(--blue), var(--purple)); color: #fff; box-shadow: 0 10px 30px rgba(59, 130, 246, 0.3); border: 1px solid rgba(255,255,255,0.1); }
    .btn-primary:hover { transform: translateY(-3px); box-shadow: 0 15px 40px rgba(139, 92, 246, 0.5); }
    .btn-outline { background: rgba(255,255,255,0.03); color: var(--txt); border: 1px solid var(--border); backdrop-filter: blur(10px); }
    .btn-outline:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.3); }

    .features-section { padding: 100px 8vw; }
    .section-header { text-align: center; margin-bottom: 60px; }
    .section-header h2 { font-size: 3rem; font-weight: 800; margin-bottom: 16px; }
    .section-header p { color: var(--txt2); font-size: 1.2rem; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 40px; transition: 0.4s; backdrop-filter: blur(10px); }
    .card:hover { transform: translateY(-10px); border-color: var(--border-hover); background: var(--card-hover); box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    .card-icon { width: 60px; height: 60px; border-radius: 16px; background: linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1)); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 1.8rem; color: var(--blue); margin-bottom: 24px; }
    .card h3 { font-size: 1.4rem; font-weight: 700; margin-bottom: 12px; }
    .card p { color: var(--txt2); line-height: 1.6; }
    ''',
    'content': '''
    <section class="hero">
      <div class="hero-badge"><i class="fa-solid fa-microchip"></i> Next-Gen Price Intelligence</div>
      <h1>Outsmart Your Competitors in Real-Time</h1>
      <p>TCM leverages AI-driven intent analysis and hybrid scraping to monitor your competitors' pricing instantly. Don't let a price change catch you off guard.</p>
      <div class="btn-group">
        <a href="/login" class="btn btn-primary"><i class="fa-solid fa-rocket"></i> Get Started Now</a>
        <a href="#features" class="btn btn-outline"><i class="fa-solid fa-compass"></i> Explore Features</a>
      </div>
    </section>

    <section id="features" class="features-section">
      <div class="section-header">
        <h2>Unfair Advantage, Built-In.</h2>
        <p>A powerhouse of intelligence packed into an intuitive platform.</p>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-icon"><i class="fa-solid fa-brain"></i></div>
          <h3>AI Keyword Expansion</h3>
          <p>Don't worry about obscure SKUs. Our AI automatically interprets part numbers (e.g., 83GW006XGP -> Lenovo V15) to track down products even when competitors hide them behind generic names.</p>
        </div>
        <div class="card">
          <div class="card-icon"><i class="fa-solid fa-bolt"></i></div>
          <h3>Lightning-Fast Hybrid Scraper</h3>
          <p>We combine raw HTTP speeds with full headless browser emulation (Puppeteer + Camoufox) to bypass the toughest anti-bot protections.</p>
        </div>
        <div class="card">
          <div class="card-icon"><i class="fa-solid fa-chart-line"></i></div>
          <h3>Real-Time Analytics</h3>
          <p>View detailed price history charts, track exact timestamps of price drops, and visualize your entire competitive landscape in one dashboard.</p>
        </div>
      </div>
    </section>
    ''',
    'extra_js': ''
}

PAGES['about.html'] = {
    'title': 'About Us',
    'extra_css': '''
    .about-hero { text-align: center; padding: 100px 20px 60px; }
    .about-hero h1 { font-size: 4rem; font-weight: 900; margin-bottom: 20px; }
    .about-hero p { color: var(--txt2); font-size: 1.2rem; max-width: 700px; margin: 0 auto; line-height: 1.7; }
    .about-content { max-width: 800px; margin: 0 auto; padding: 40px 20px 100px; }
    .about-content h2 { font-size: 2rem; margin: 40px 0 20px; color: var(--blue); }
    .about-content p { font-size: 1.1rem; color: #cbd5e1; line-height: 1.8; margin-bottom: 20px; }
    ''',
    'content': '''
    <div class="about-hero">
      <h1>About GCM</h1>
      <p>Pioneering the next generation of e-commerce intelligence.</p>
    </div>
    <div class="about-content">
      <h2>Our Mission</h2>
      <p>At Galaxy (Technodel), we believe that pricing data shouldn't be a black box. Our mission is to democratize price intelligence by giving retailers, distributors, and brands the power to see exactly what their competitors are doing in real-time.</p>
      
      <h2>The Technology</h2>
      <p>We built GCM from the ground up using state-of-the-art AI and hybrid scraping technology. By intelligently analyzing search intents and dynamically bypassing advanced bot protections, GCM ensures you never miss a critical price change.</p>
    </div>
    ''',
    'extra_js': ''
}

PAGES['contact.html'] = {
    'title': 'Contact',
    'extra_css': '''
    .contact-container { max-width: 600px; margin: 80px auto; padding: 50px; background: var(--card); border: 1px solid var(--border); border-radius: 24px; backdrop-filter: blur(10px); }
    .contact-container h1 { font-size: 2.5rem; margin-bottom: 10px; text-align: center; }
    .contact-container p { color: var(--txt2); text-align: center; margin-bottom: 40px; }
    .form-group { margin-bottom: 24px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
    .form-control { width: 100%; padding: 14px 18px; border-radius: 12px; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: #fff; font-family: inherit; font-size: 1rem; transition: 0.3s; }
    .form-control:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
    .btn-submit { width: 100%; padding: 16px; border-radius: 12px; background: linear-gradient(135deg, var(--blue), var(--purple)); color: #fff; font-weight: 700; font-size: 1.1rem; border: none; cursor: pointer; transition: 0.3s; }
    .btn-submit:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(139,92,246,0.4); }
    ''',
    'content': '''
    <div class="contact-container">
      <h1>Get in Touch</h1>
      <p>Have questions? We'd love to hear from you.</p>
      <form onsubmit="event.preventDefault(); alert('Message sent!');">
        <div class="form-group">
          <label>Your Name</label>
          <input type="text" class="form-control" required placeholder="John Doe">
        </div>
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" class="form-control" required placeholder="john@example.com">
        </div>
        <div class="form-group">
          <label>Message</label>
          <textarea class="form-control" rows="5" required placeholder="How can we help?"></textarea>
        </div>
        <button type="submit" class="btn-submit">Send Message</button>
      </form>
    </div>
    ''',
    'extra_js': ''
}

PAGES['pricing.html'] = {
    'title': 'Pricing',
    'extra_css': '''
    .pricing-hero { text-align: center; padding: 80px 20px 40px; }
    .pricing-hero h1 { font-size: 3.5rem; font-weight: 900; margin-bottom: 20px; }
    .pricing-hero p { color: var(--txt2); font-size: 1.2rem; }
    .pricing-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 30px; padding: 20px 8vw 100px; }
    .plan-card { width: 340px; background: var(--card); border: 1px solid var(--border); border-radius: 24px; padding: 40px; transition: 0.4s; position: relative; overflow: hidden; backdrop-filter: blur(10px); }
    .plan-card:hover { transform: translateY(-10px); border-color: var(--blue); box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .plan-card.popular { border-color: var(--purple); background: linear-gradient(180deg, rgba(139,92,246,0.1) 0%, var(--card) 100%); }
    .plan-card.popular::before { content: 'MOST POPULAR'; position: absolute; top: 20px; right: -35px; background: var(--purple); color: #fff; font-size: 0.7rem; font-weight: 800; padding: 6px 40px; transform: rotate(45deg); letter-spacing: 1px; }
    .plan-name { font-size: 1.6rem; font-weight: 800; margin-bottom: 10px; }
    .plan-price { font-size: 3.5rem; font-weight: 900; margin-bottom: 20px; display: flex; align-items: baseline; gap: 5px; }
    .plan-price span { font-size: 1rem; color: var(--txt2); font-weight: 500; }
    .plan-features { list-style: none; margin-bottom: 40px; }
    .plan-features li { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; color: #cbd5e1; font-size: 0.95rem; }
    .plan-features li i { color: var(--blue); margin-top: 4px; font-size: 0.9rem; }
    .btn-plan { width: 100%; padding: 14px; border-radius: 12px; text-align: center; text-decoration: none; font-weight: 700; font-size: 1.1rem; display: block; transition: 0.3s; }
    .btn-plan-outline { background: rgba(255,255,255,0.05); color: #fff; border: 1px solid var(--border); }
    .btn-plan-outline:hover { background: rgba(255,255,255,0.1); border-color: #fff; }
    .btn-plan-solid { background: linear-gradient(135deg, var(--blue), var(--purple)); color: #fff; border: none; box-shadow: 0 8px 20px rgba(139,92,246,0.4); }
    .btn-plan-solid:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(139,92,246,0.6); }
    ''',
    'content': '''
    <div class="pricing-hero">
      <h1>Simple, Transparent Pricing</h1>
      <p>Powerful price intelligence for businesses of all sizes.</p>
    </div>
    <div class="pricing-grid" id="pricing-container">
      <!-- Injected by JS -->
      <div style="text-align:center;width:100%;"><i class="fa-solid fa-circle-notch fa-spin fa-2x"></i></div>
    </div>
    ''',
    'extra_js': '''
    <script>
      async function loadPricing() {
        try {
          const res = await fetch('/api/pricing');
          const plans = await res.json();
          const container = document.getElementById('pricing-container');
          container.innerHTML = '';
          
          plans.forEach((plan, idx) => {
             const isPopular = idx === 1; // 2nd plan is popular
             let featuresHtml = plan.features.map(f => `<li><i class="fa-solid fa-check"></i> ${f}</li>`).join('');
             
             let btnClass = isPopular ? 'btn-plan-solid' : 'btn-plan-outline';
             let cardClass = isPopular ? 'plan-card popular' : 'plan-card';

             container.innerHTML += `
               <div class="${cardClass}">
                 <div class="plan-name">${plan.name}</div>
                 <div class="plan-price">$${plan.price} <span>/ month</span></div>
                 <ul class="plan-features">
                   ${featuresHtml}
                 </ul>
                 <a href="/login" class="btn-plan ${btnClass}">Choose ${plan.name}</a>
               </div>
             `;
          });
        } catch(e) {
          console.error(e);
        }
      }
      loadPricing();
    </script>
    '''
}

for filename, data in PAGES.items():
    path = os.path.join('public', filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(HTML_TEMPLATE.format(**data))
        print(f"Wrote {path}")

