(function () {
  "use strict";

  var stage = document.getElementById("stage");
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var current = 0;
  var timer = 0;

  function fitStage() {
    document.documentElement.classList.add("fit");
    var scale = Math.min(window.innerWidth / 2160, window.innerHeight / 3840);
    stage.style.transform = "scale(" + scale + ")";
    stage.style.marginLeft = Math.max(0, (window.innerWidth - 2160 * scale) / 2) + "px";
  }

  function show(index) {
    window.clearTimeout(timer);
    current = (index + slides.length) % slides.length;
    slides.forEach(function (slide, slideIndex) {
      slide.classList.toggle("is-active", slideIndex === current);
      slide.setAttribute("aria-hidden", slideIndex === current ? "false" : "true");
    });
    var duration = Number(slides[current].getAttribute("data-duration")) || 12000;
    timer = window.setTimeout(function () { show(current + 1); }, duration);
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") show(current + 1);
    if (event.key === "ArrowLeft" || event.key === "PageUp") show(current - 1);
  });

  fitStage();
  window.addEventListener("resize", fitStage);
  show(0);

  var now = new Date();
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
  window.setTimeout(function () { window.location.reload(); }, next.getTime() - now.getTime());
})();
