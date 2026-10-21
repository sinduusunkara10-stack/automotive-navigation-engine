// A generic proprietary form validator: per-control touched tracking, row classes, an error icon
// drawn by CSS and a submit handler that cancels the submission. The behaviour is chosen by the
// fixture page through window.__validatorScenario.
(function () {
  const scenario = window.__validatorScenario;
  const form = document.getElementById("lead-form");
  const touched = new WeakSet();
  const rowOf = (el) => el.closest(".field-row");
  const required = () => Array.from(form.querySelectorAll("[data-rule-required]"));

  form.addEventListener("focusout", function trackTouched(e) {
    touched.add(e.target);
    const row = rowOf(e.target);
    if (row && e.target.matches("input:not([readonly]), select")) row.classList.replace("is-untouched", "is-touched");
  });
  if (scenario === "change_touched") {
    form.addEventListener("change", function trackChanged(e) {
      touched.add(e.target);
      const row = rowOf(e.target);
      if (row) row.classList.replace("is-untouched", "is-touched");
    });
  }

  const succeed = () => {
    fetch("/api/lead", { method: "POST", body: "lead=1" }).then(() => {
      const box = document.createElement("div");
      box.setAttribute("role", "status");
      box.textContent = "Merci, votre demande a bien été enregistrée.";
      document.getElementById("region").appendChild(box);
    });
  };

  function validateLeadForm(e) {
    window.__submitCount += 1;
    if (scenario === "jquery_pending") {
      rowOf(form.querySelector("#email")).classList.add("is-pending");
      return false;
    }
    e.preventDefault();
    if (scenario === "silent_class" || scenario === "message") {
      const row = rowOf(form.querySelector("#email"));
      row.classList.add("has-error");
      if (scenario === "message") {
        const msg = document.createElement("span");
        msg.className = "field-message";
        msg.textContent = "Adresse e-mail invalide";
        row.appendChild(msg);
      }
      form.dataset.formValid = "false";
      return;
    }
    if (scenario === "count_only") {
      if (!form.querySelector(".form-errors")) {
        const box = document.createElement("div");
        box.className = "form-errors";
        box.textContent = "Le formulaire contient 1 erreur";
        form.appendChild(box);
      }
      return;
    }
    if (scenario === "untouched_reject" || scenario === "change_touched" || scenario === "blur_touched") {
      const untouched = required().filter((el) => !touched.has(el));
      untouched.forEach((el) => rowOf(el).classList.add("has-error"));
      if (untouched.length > 0) return;
    }
    const honeypot = form.querySelector("#website");
    if (honeypot && honeypot.value) return;
    succeed();
  }

  if (scenario === "jquery_pending") {
    window.jQuery.data(form, "validator", { pendingRequest: 1, pending: { email: true }, invalid: {}, errorList: [], submitted: {} });
    window.jQuery(document).on("submit", "#lead-form", validateLeadForm);
  } else {
    form.addEventListener("submit", validateLeadForm);
  }
})();
