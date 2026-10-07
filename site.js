// gusandbrad.com — the show open's sound button, Gus's tall tale, the dial, the solar meter.
(function () {
  // The show open loops silently; SOUND ON plays it once from the top with sound.
  var open = document.getElementById("open"), sound = document.getElementById("sound");
  if (open && sound) {
    sound.addEventListener("click", function () {
      open.loop = false; open.muted = false; open.currentTime = 0; open.play();
      sound.hidden = true;
    });
    open.addEventListener("ended", function () {
      open.muted = true; open.loop = true; open.play(); sound.hidden = false;
    });
  }

  // Hear Gus. gus_face.js is the rig's own face (cohost/rig/assets/scope.js, copied at
  // publish), so he looks exactly as he does on camera: his voice runs through the face's
  // sink, the trace IS his voice, and the cues below are the same [face: ...] cues the
  // brain sends on set, timed to this clip's phrases. The TALL ONE tag is the booth's.
  var tale = document.getElementById("tale"), audio = document.getElementById("tale-audio");
  var tall = document.getElementById("tall"), led = document.getElementById("led");
  var CUES = [[0.2, "warm"], [3.5, "left"], [5.6, "happy"], [8.5, "neutral"],
              [10.9, "sad"], [13.1, "wink"], [13.5, "smile"]];
  var actx = null, nextCue = 0;
  // scope.js declares `const Scope` at top level: a global, but NOT a window property
  var GUS = typeof Scope !== "undefined" ? Scope : null;
  var face = GUS ? GUS.face : function () {};
  if (GUS && "IntersectionObserver" in window) {
    var screenEl = document.querySelector(".gus-screen");
    new IntersectionObserver(function (es, io) {
      if (es[0].isIntersecting) { Scope.power(true); led.classList.add("lit"); io.disconnect(); }
    }, { threshold: 0.4 }).observe(screenEl);
  } else if (GUS) { GUS.power(true); }
  function tick() {
    if (audio.paused) return;
    while (nextCue < CUES.length && audio.currentTime >= CUES[nextCue][0]) face(CUES[nextCue++][1]);
    requestAnimationFrame(tick);
  }
  if (tale && audio) {
    var icon = tale.querySelector(".tale-icon");
    tale.addEventListener("click", function () {
      if (GUS && !actx) {
        try {
          actx = new (window.AudioContext || window.webkitAudioContext)();
          actx.createMediaElementSource(audio).connect(Scope.sink(actx));
        } catch (e) { actx = null; }
      }
      if (actx && actx.state === "suspended") actx.resume();
      if (GUS) { GUS.power(true); led.classList.add("lit"); }
      if (audio.paused) { nextCue = 0; audio.currentTime = 0; audio.play(); }
      else { audio.pause(); audio.currentTime = 0; }
    });
    audio.addEventListener("play", function () {
      icon.innerHTML = "&#9632;"; tale.classList.add("on"); tall.classList.add("up"); tick();
    });
    ["pause", "ended"].forEach(function (e) {
      audio.addEventListener(e, function () {
        icon.innerHTML = "&#9654;"; tale.classList.remove("on");
        setTimeout(function () { if (audio.paused) tall.classList.remove("up"); }, 1500);
      });
    });
  }

  // The tuning dial: the needle sits on the section you're reading.
  var links = [].slice.call(document.querySelectorAll(".dial a")), needle = document.querySelector(".needle");
  function park(a) {
    if (!a || !needle) return;
    needle.style.left = (a.offsetLeft + a.offsetWidth / 2) + "px";
    links.forEach(function (l) { l.classList.toggle("on", l === a); });
  }
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) park(links.filter(function (l) { return l.hash === "#" + e.target.id; })[0]);
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    links.forEach(function (l) { var t = document.querySelector(l.hash); if (t) io.observe(t); });
  }
  park(links[0]);
  window.addEventListener("resize", function () { park(document.querySelector(".dial a.on") || links[0]); });

  // The solar meter. solar_post.py on the shop laptop posts a delayed, rounded reading
  // to the site repo's "meter" branch; no house usage is ever posted.
  var URL = "https://raw.githubusercontent.com/bfreemannh-a11y/gusandbrad-site/meter/solar.json";
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  function ago(sec) {
    var m = Math.round(sec / 60);
    if (m < 90) return "about " + m + " minutes ago";
    return "about " + Math.round(m / 60) + " hours ago";
  }
  function napping(why) {
    set("m-foot", why);
    document.getElementById("meter").classList.add("napping");
  }
  fetch(URL + "?t=" + Math.floor(Date.now() / 300000), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (d) {
      var age = Date.now() / 1000 - d.as_of;
      if (!(age < 4 * 3600)) return napping("The meter's napping. Back soon.");
      var kw = d.sun_w / 1000;
      set("m-sun", kw < 0.05 ? "0 kW" : kw.toFixed(1) + " kW");
      set("m-bat", d.battery_pct + "%");
      set("m-today", d.today_kwh.toFixed(1) + " kWh");
      document.getElementById("m-fill").style.width = Math.max(0, Math.min(100, d.battery_pct)) + "%";
      document.getElementById("lamp").classList.add("lit");
      var foot = "Read " + ago(age) + " (we post it an hour behind).";
      if (d.lifetime) foot += " Made here, all told: " + d.lifetime + ".";
      set("m-foot", foot);
    })
    .catch(function () { napping("The meter's napping. Back soon."); });
})();
