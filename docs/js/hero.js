// the hero bubble shows one example at a time, and moves to the next every few seconds
// it stops while the mouse is on the bubble, and does not move for reduced motion
const bubble = document.querySelector(".hero-bubble");
const examples = bubble.querySelectorAll("pre");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (examples.length > 1 && !still) {
  let shown = 0;
  let paused = false;
  bubble.classList.add("cycling");
  examples[0].classList.add("shown");
  bubble.addEventListener("mouseenter", () => { paused = true; });
  bubble.addEventListener("mouseleave", () => { paused = false; });
  setInterval(() => {
    if (paused) {
      return;
    }
    examples[shown].classList.remove("shown");
    shown = (shown + 1) % examples.length;
    examples[shown].classList.add("shown");
  }, 6000);
}
