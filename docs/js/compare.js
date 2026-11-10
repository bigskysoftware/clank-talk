// a .compare block becomes one view with a bar: drag it to show bash or ClankTalk
// a range input does the work, so the mouse, touch and the keyboard all move the bar
for (const compare of document.querySelectorAll(".compare")) {
  const bar = document.createElement("div");
  bar.className = "compare-bar";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.value = "50";
  range.className = "compare-range";
  range.setAttribute("aria-label", "Drag to show bash or ClankTalk");
  range.addEventListener("input", () => {
    compare.style.setProperty("--split", range.value + "%");
  });
  compare.append(bar, range);
  compare.classList.add("slider");
}
