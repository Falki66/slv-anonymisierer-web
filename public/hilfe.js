(function () {
  var p = document.getElementById("printlink");
  if (p) p.addEventListener("click", function (e) { e.preventDefault(); window.print(); });
})();
