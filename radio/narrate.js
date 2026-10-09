// Gus in the corner of "Follow the Power" (website copy only), speaking every stage.
// The deck is circuit_explainer/demo_radio_schematic.html, copied by publish.py with its buttons and
// written text hidden and this script added. gus_face.js is the rig's own face.
// ../media/radio_demo.json (demo_radio/render.py) holds [second, "stage:N"] cues timed to his clip.
// Plays once per click (browsers won't play sound before a click); "again" replays it; Stop (Brad 10-09) ends it.
(function () {
  var GUS = typeof Scope !== "undefined" ? Scope : null;
  var box = document.getElementById("gus-corner"), audio = document.getElementById("gus-audio"),
      led = document.getElementById("gus-led"), go = document.getElementById("gus-start"),
      stop = document.getElementById("gus-stop");
  var plan = null, next = 0, actx = null;

  var wrap = document.getElementById("stage-wrap");   // Gus and the start button sit on the picture
  if (wrap) {
    if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    wrap.appendChild(box); wrap.appendChild(go); wrap.appendChild(stop);
  }
  if (GUS) { GUS.power(true); led.classList.add("lit"); }

  function stage(n) { i = Math.max(0, Math.min(TOUR.length - 1, n - 1)); render(); }   // the deck's own i + render()

  fetch("../media/radio_demo.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (j) { if (j.cues && j.cues.length) { plan = j; go.classList.add("ready"); } })
    .catch(function () { go.querySelector("span").textContent = "Gus is still rehearsing this one"; });

  function fire() {
    if (!plan) return;
    while (next < plan.cues.length && audio.currentTime >= plan.cues[next][0]) {
      var c = String(plan.cues[next++][1]).split(":");
      if (c[0] === "stage") stage(parseInt(c[1], 10));
      else if (c[0] === "face" && GUS) GUS.face(c[1]);
    }
  }
  function loop() { if (audio.paused) return; fire(); requestAnimationFrame(loop); }
  function play() {
    if (!plan) return;
    if (GUS && !actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        actx.createMediaElementSource(audio).connect(GUS.sink(actx));
      } catch (e) { actx = null; }
    }
    if (actx && actx.state === "suspended") actx.resume();
    clearOverlays(); next = 0; audio.currentTime = 0; audio.play();
    go.classList.add("gone"); stop.classList.add("on");
  }
  function done() {
    go.querySelector("span").textContent = "Again";
    go.classList.remove("gone"); stop.classList.remove("on");
  }
  function halt() { audio.pause(); audio.currentTime = 0; next = 0; done(); }
  go.addEventListener("click", play);
  stop.addEventListener("click", halt);
  audio.addEventListener("play", loop);
  audio.addEventListener("timeupdate", fire);   // backup when frames are throttled (tab in the background)
  audio.addEventListener("ended", done);
  window.addEventListener("message", function (e) { if (e.data === "gus-explain" && audio.paused) play(); });
})();
