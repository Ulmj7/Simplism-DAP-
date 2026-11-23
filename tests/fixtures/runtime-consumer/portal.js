const render = () => {
  const detail = document.body.dataset.routing === "history" ? location.pathname === "/profile" : location.hash === "#/profile";
  document.querySelector("main").hidden = !detail;
  document.querySelector("nav").hidden = detail;
};
const navigation = document.querySelector("a");
navigation.addEventListener("click", event => {
  if (document.body.dataset.routing !== "history") return;
  event.preventDefault();
  history.pushState(null, "", navigation.href);
  render();
});
addEventListener("hashchange", render);
addEventListener("popstate", render);
document.querySelector("#save").addEventListener("click", () => {
  document.querySelector("#saved").textContent = "Saved";
});
document.querySelector("#label").addEventListener("input", () => {
  document.querySelector("#saved").textContent = "";
});
render();
