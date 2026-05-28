const heart_rate_dom_elements = {};

document.querySelector("#close").addEventListener("click", window.api.close);

window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') document.querySelector('html').classList.add('shift-held');
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') document.querySelector('html').classList.remove('shift-held');
});
window.addEventListener('blur', () => {
    document.querySelector('html').classList.remove('shift-held');
});

document.querySelector("#add").addEventListener('click', () => {
    const idInput = document.querySelector("#add-id");
    const nameInput = document.querySelector("#add-name");
    const id = idInput.value.trim();
    if (!id) return;
    window.api.addTracker(id, nameInput.value.trim());
    idInput.value = '';
    nameInput.value = '';
});
document.querySelector("#opacity").addEventListener('input', () => {
    document.querySelectorAll(".background").forEach((background) => {
        background.className = "background opacity-" + document.querySelector("#opacity").value;
    });
});

window.api.onHeartRateUpdate((_event, IDs) => {
    console.log(IDs);
    resizeTo(Math.max(Object.keys(IDs).length * 100, 100), 100);
    Object.keys(heart_rate_dom_elements).forEach((existingID) => {
        if (!(existingID in IDs)) {
            heart_rate_dom_elements[existingID].remove();
            delete heart_rate_dom_elements[existingID];
        }
    });
    Object.keys(IDs).forEach((ID) => {
        if (!(ID in heart_rate_dom_elements)) {
            let node = document.querySelector("#heart_rate_template").cloneNode(true);
            node.id = "heart_rate_" + ID;
            node.classList.remove("hidden");
            node.querySelector(".remove-btn").addEventListener('click', (e) => {
                e.stopPropagation();
                window.api.removeTracker(ID);
            });
            document.querySelector("#app").appendChild(node);
            heart_rate_dom_elements[ID] = document.querySelector("#heart_rate_" + ID);
        }
        heart_rate_dom_elements[ID].querySelector(".identicator").innerHTML = IDs[ID].name;
        heart_rate_dom_elements[ID].querySelector(".heart_rate").innerHTML = IDs[ID].lastHeartrate;
        if (Math.abs(IDs[ID].lastUpdate - Date.now()) > 30 * 1000) {
            heart_rate_dom_elements[ID].querySelector(".last_update").classList.remove("hidden");
        } else {
            heart_rate_dom_elements[ID].querySelector(".last_update").classList.add("hidden");
        }
        if (Math.abs(IDs[ID].lastUpdate - Date.now()) < 5 * 60 * 1000) {
            heart_rate_dom_elements[ID].querySelector(".last_update").innerHTML = parseInt(Math.abs(IDs[ID].lastUpdate - Date.now()) / 1000) + "s ago";
        } else {
            heart_rate_dom_elements[ID].querySelector(".last_update").innerHTML = "a while ago";
        }
    });
    if (Object.keys(IDs).length > 0) {
        document.querySelector("html").classList.remove("force-hover");
    } else {
        document.querySelector("html").classList.add("force-hover");
    }
})