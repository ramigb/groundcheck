const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const header = document.querySelector(".site-header");
const setHeaderState = () => header?.classList.toggle("compact", window.scrollY > 40);
setHeaderState();
window.addEventListener("scroll", setHeaderState, { passive: true });

const revealItems = [...document.querySelectorAll(".reveal")];
if (reducedMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const siblings = [...(entry.target.parentElement?.children ?? [])].filter((node) => node.classList?.contains("reveal"));
      const index = Math.max(0, siblings.indexOf(entry.target));
      entry.target.style.transitionDelay = `${Math.min(index * 70, 280)}ms`;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -35px" });
  revealItems.forEach((item) => revealObserver.observe(item));
}

const tabButtons = [...document.querySelectorAll("[role='tab'][data-view]")];
const panels = {
  graph: document.querySelector("#panel-graph"),
  collapsed: document.querySelector("#panel-collapsed")
};

function activateTab(button) {
  const view = button.dataset.view;
  tabButtons.forEach((tab) => {
    const active = tab === button;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  Object.entries(panels).forEach(([key, panel]) => {
    if (panel) panel.hidden = key !== view;
  });
}

tabButtons.forEach((button, index) => {
  button.addEventListener("click", () => activateTab(button));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabButtons.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabButtons.length) % tabButtons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabButtons.length - 1;
    activateTab(tabButtons[next]);
    tabButtons[next].focus();
  });
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.dataset.copy;
    const label = button.querySelector("span");
    try {
      await navigator.clipboard.writeText(text);
      if (label) label.textContent = "Copied";
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      if (label) label.textContent = "Copied";
    }
    window.setTimeout(() => {
      if (label) label.textContent = "Copy";
    }, 1800);
  });
});

if (!reducedMotion && window.matchMedia("(pointer: fine)").matches) {
  document.querySelectorAll("[data-tilt]").forEach((area) => {
    area.addEventListener("pointermove", (event) => {
      const rect = area.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      const windowElement = area.querySelector(".artifact-window:not([hidden])");
      if (!windowElement) return;
      const baseY = area.classList.contains("hero-visual") ? -7 : 0;
      windowElement.style.transform = `rotateY(${baseY + x * 3.5}deg) rotateX(${-y * 3.5}deg)`;
    });
    area.addEventListener("pointerleave", () => {
      const windowElement = area.querySelector(".artifact-window:not([hidden])");
      if (!windowElement) return;
      windowElement.style.transform = area.classList.contains("hero-visual")
        ? "rotateY(-7deg) rotateX(2deg)"
        : "rotateY(0) rotateX(0)";
    });
  });
}
