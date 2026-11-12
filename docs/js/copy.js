// a small Copy button in the title bar of each code window; a "$ " prompt is not copied
for (const frame of document.querySelectorAll(".window")) {
  const pre = frame.querySelector("pre");
  const title = frame.querySelector(".window-title");
  if (pre === null || title === null) {
    continue;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "window-copy";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(pre.textContent.replace(/^\$ /gm, ""));
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  });
  title.append(button);
}
