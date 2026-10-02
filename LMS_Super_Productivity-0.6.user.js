// ==UserScript==
// @name         LMS → Super Productivity
// @namespace    https://learn-it.com/
// @version      0.6
// @description  Importiert LMS-Aufgaben in Super Productivity und zeigt erledigte Abgaben im LMS an
// @match        https://lms.learn-it.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    "use strict";

    const API_URL = "http://127.0.0.1:3876";

    // Alle 30 Sekunden Status prüfen
    const STATUS_CHECK_INTERVAL = 30 * 1000;

    let API_TOKEN = GM_getValue("sp_api_token", "");

    let statusCheckTimer = null;

    // ------------------------------------------------------------
    // Super Productivity API
    // ------------------------------------------------------------

    function apiRequest(path, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || "GET",
                url: `${API_URL}${path}`,

                headers: {
                    "Authorization": `Bearer ${API_TOKEN}`,
                    "Content-Type": "application/json"
                },

                data: options.body || undefined,

                timeout: 10000,

                onload: function (response) {
                    let data;

                    try {
                        data = JSON.parse(response.responseText);
                    } catch (error) {
                        reject(
                            new Error(
                                `Ungültige Antwort von Super Productivity (HTTP ${response.status})`
                            )
                        );
                        return;
                    }

                    if (
                        response.status < 200 ||
                        response.status >= 300
                    ) {
                        reject(
                            new Error(
                                data?.error?.message ||
                                `HTTP ${response.status}`
                            )
                        );
                        return;
                    }

                    if (data.ok === false) {
                        reject(
                            new Error(
                                data?.error?.message ||
                                "Super Productivity API Fehler"
                            )
                        );
                        return;
                    }

                    resolve(data.data);
                },

                onerror: function () {
                    reject(
                        new Error(
                            "Keine Verbindung zu Super Productivity möglich."
                        )
                    );
                },

                ontimeout: function () {
                    reject(
                        new Error(
                            "Zeitüberschreitung bei der Verbindung zu Super Productivity."
                        )
                    );
                }
            });
        });
    }

    async function getProjects() {
        return await apiRequest("/projects");
    }

    async function getTags() {
        return await apiRequest("/tags");
    }

    async function getExistingTasks(projectId) {
        const params = new URLSearchParams({
            projectId: projectId,
            source: "all",
            includeDone: "true"
        });

        return await apiRequest(
            `/tasks?${params.toString()}`
        );
    }

    async function updateTask(taskId, updates) {
        return await apiRequest(
            `/tasks/${taskId}`,
            {
                method: "PATCH",
                body: JSON.stringify(updates)
            }
        );
    }

    // ------------------------------------------------------------
    // LMS
    // ------------------------------------------------------------

    function getLmsTasks() {
        const rows = document.querySelectorAll(
            ".ilContainerItemsContainer .ilObjListRow"
        );

        const tasks = [];

        rows.forEach(row => {
            const link = row.querySelector(
                ".il_ContainerItemTitle a"
            );

            if (!link) {
                return;
            }

            let title = link.textContent.trim();

            const url = link.href;

            // Letzten [....]-Block entfernen.
            //
            // [GG] Praxisübung Form 01 : Zufallsform [KK]
            //
            // wird zu:
            //
            // [GG] Praxisübung Form 01 : Zufallsform

            title = title.replace(
                /\s*\[[^\]]+\]\s*$/,
                ""
            );

            // Prefix am Anfang suchen

            const prefixMatch =
                title.match(/^(\[[^\]]+\])/);

            if (!prefixMatch) {
                console.warn(
                    "Kein Prefix gefunden:",
                    title
                );

                return;
            }

            const prefix =
                prefixMatch[1];

            tasks.push({
                title: title,
                url: url,
                prefix: prefix,
                row: row,
                link: link
            });
        });

        return tasks;
    }

    // ------------------------------------------------------------
    // Projekt / Tag suchen
    // ------------------------------------------------------------

    function findProject(prefix, projects) {
        return projects.find(project => {
            return project.title
                .trim()
                .toUpperCase()
                .startsWith(
                    prefix.toUpperCase()
                );
        });
    }

    function findTag(prefix, tags) {
        return tags.find(tag => {
            return tag.title
                .trim()
                .toUpperCase() ===
                prefix.toUpperCase();
        });
    }

    // ------------------------------------------------------------
    // Titel normalisieren
    // ------------------------------------------------------------

    function normalizeTitle(title) {
        return title
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
    }

    // ------------------------------------------------------------
    // Vorhandene Aufgabe suchen
    //
    // 1. LMS-URL
    // 2. Titel
    // ------------------------------------------------------------

    function findExistingTask(
        task,
        existingTasks
    ) {
        const searchText =
            `LMS:\n${task.url}`;

        // --------------------------------------------------------
        // 1. Über LMS-URL suchen
        // --------------------------------------------------------

        const urlMatch =
            existingTasks.find(
                existingTask => {

                    if (!existingTask.notes) {
                        return false;
                    }

                    return existingTask.notes
                        .includes(searchText);
                }
            );

        if (urlMatch) {
            return {
                task: urlMatch,
                matchedBy: "url"
            };
        }

        // --------------------------------------------------------
        // 2. Über Titel suchen
        // --------------------------------------------------------

        const normalizedTitle =
            normalizeTitle(
                task.title
            );

        const titleMatch =
            existingTasks.find(
                existingTask => {

                    if (!existingTask.title) {
                        return false;
                    }

                    return (
                        normalizeTitle(
                            existingTask.title
                        ) === normalizedTitle
                    );
                }
            );

        if (titleMatch) {
            return {
                task: titleMatch,
                matchedBy: "title"
            };
        }

        return null;
    }

    // ------------------------------------------------------------
    // LMS-URL zu vorhandener Aufgabe hinzufügen
    // ------------------------------------------------------------

    async function addLmsUrlToExistingTask(
        existingTask,
        lmsUrl
    ) {
        const currentNotes =
            existingTask.notes || "";

        const lmsEntry =
            `LMS:\n${lmsUrl}`;

        if (
            currentNotes.includes(
                lmsEntry
            )
        ) {
            return existingTask;
        }

        let newNotes;

        if (
            currentNotes.trim() === ""
        ) {
            newNotes = lmsEntry;
        } else {
            newNotes =
                `${currentNotes.trim()}\n\n${lmsEntry}`;
        }

        return await updateTask(
            existingTask.id,
            {
                notes: newNotes
            }
        );
    }

    // ------------------------------------------------------------
    // Neue Aufgabe erstellen
    // ------------------------------------------------------------

    async function createTask(
        task,
        projectId,
        tagId
    ) {
        const body = {
            title: task.title,
            notes: `LMS:\n${task.url}`,
            projectId: projectId
        };

        if (tagId) {
            body.tagIds = [tagId];
        }

        return await apiRequest(
            "/tasks",
            {
                method: "POST",
                body: JSON.stringify(body)
            }
        );
    }

    // ------------------------------------------------------------
    // Subtask "erledigt"
    // ------------------------------------------------------------

    async function createDoneSubtask(
        parentId
    ) {
        return await apiRequest(
            "/tasks",
            {
                method: "POST",

                body: JSON.stringify({
                    title: "erledigt",
                    parentId: parentId
                })
            }
        );
    }

    // ------------------------------------------------------------
    // Super Productivity Status prüfen
    //
    // Diese Funktion wird alle 30 Sekunden aufgerufen,
    // solange die PROJEKTABGABEN-Seite geöffnet ist.
    // ------------------------------------------------------------

    async function checkSuperProductivityStatus() {

        // Sicherheit:
        // Nicht auf anderen LMS-Seiten prüfen.

        if (!isProjectAbgabenPage()) {
            stopStatusChecking();
            return;
        }

        if (!API_TOKEN) {
            return;
        }

        let projects;

        try {
            projects = await getProjects();
        } catch (error) {

            // Super Productivity läuft möglicherweise gerade nicht.
            // Keine Meldung anzeigen, da dies beim automatischen
            // Hintergrundcheck sonst störend wäre.

            console.debug(
                "Super Productivity nicht erreichbar:",
                error.message
            );

            return;
        }

        // --------------------------------------------------------
        // LMS-Aufgaben auf der aktuellen Seite
        // --------------------------------------------------------

        const lmsTasks =
            getLmsTasks();

        if (lmsTasks.length === 0) {
            return;
        }

        // --------------------------------------------------------
        // Nach Prefix gruppieren
        // --------------------------------------------------------

        const groupedTasks =
            new Map();

        for (const task of lmsTasks) {

            if (
                !groupedTasks.has(
                    task.prefix
                )
            ) {
                groupedTasks.set(
                    task.prefix,
                    []
                );
            }

            groupedTasks
                .get(task.prefix)
                .push(task);
        }

        // --------------------------------------------------------
        // Für jedes Projekt die Tasks laden
        // --------------------------------------------------------

        for (
            const [prefix, prefixTasks]
            of groupedTasks
        ) {

            const project =
                findProject(
                    prefix,
                    projects
                );

            if (!project) {
                continue;
            }

            let existingTasks;

            try {

                existingTasks =
                    await getExistingTasks(
                        project.id
                    );

            } catch (error) {

                console.debug(
                    `Aufgaben von ${project.title} konnten nicht geladen werden:`,
                    error.message
                );

                continue;
            }

            // ----------------------------------------------------
            // LMS-Aufgaben mit SP-Aufgaben vergleichen
            // ----------------------------------------------------

            for (
                const lmsTask
                of prefixTasks
            ) {

                const existing =
                    findExistingTask(
                        lmsTask,
                        existingTasks
                    );

                if (!existing) {
                    continue;
                }

                const spTask =
                    existing.task;

                // ------------------------------------------------
                // Nur Hauptaufgaben betrachten.
                //
                // Subtasks haben parentId.
                // ------------------------------------------------

                if (spTask.parentId) {
                    continue;
                }

                // ------------------------------------------------
                // Haupttask erledigt?
                //
                // Nur dann wird die LMS-Aufgabe markiert.
                //
                // Der Subtask "erledigt" spielt hier bewusst
                // keine Rolle.
                // ------------------------------------------------

                if (spTask.isDone) {

                    markLmsTaskAsUploaded(
                        lmsTask
                    );

                } else {

                    unmarkLmsTask(
                        lmsTask
                    );
                }
            }
        }
    }

    // ------------------------------------------------------------
    // LMS-Aufgabe als hochgeladen markieren
    // ------------------------------------------------------------

    function markLmsTaskAsUploaded(
        lmsTask
    ) {
        const row =
            lmsTask.row;

        if (!row) {
            return;
        }

        // Bereits markiert?
        if (
            row.dataset.spUploaded ===
            "true"
        ) {
            return;
        }

        row.dataset.spUploaded =
            "true";

        // Originalzustand speichern
        if (
            !row.dataset.spOriginalOpacity
        ) {
            row.dataset.spOriginalOpacity =
                row.style.opacity || "";
        }

        if (
            !row.dataset.spOriginalTextDecoration
        ) {
            row.dataset.spOriginalTextDecoration =
                lmsTask.link.style
                    .textDecoration || "";
        }

        // --------------------------------------------------------
        // Zeile optisch ausgrauen
        // --------------------------------------------------------

        row.style.opacity = "0.55";

        // --------------------------------------------------------
        // Link durchstreichen
        // --------------------------------------------------------

        lmsTask.link.style.textDecoration =
            "line-through";

        // --------------------------------------------------------
        // Haken vor dem Titel
        // --------------------------------------------------------

        if (
            !lmsTask.link.dataset.spCheckAdded
        ) {

            const check =
                document.createElement(
                    "span"
                );

            check.textContent =
                "✓ ";

            check.dataset.spCheck =
                "true";

            check.style.fontWeight =
                "bold";

            check.style.textDecoration =
                "none";

            lmsTask.link.prepend(
                check
            );

            lmsTask.link.dataset.spCheckAdded =
                "true";
        }
    }

    // ------------------------------------------------------------
    // LMS-Aufgabe wieder normal darstellen
    // ------------------------------------------------------------

    function unmarkLmsTask(
        lmsTask
    ) {
        const row =
            lmsTask.row;

        if (!row) {
            return;
        }

        if (
            row.dataset.spUploaded !==
            "true"
        ) {
            return;
        }

        row.dataset.spUploaded =
            "false";

        // --------------------------------------------------------
        // Haken entfernen
        // --------------------------------------------------------

        const check =
            lmsTask.link.querySelector(
                '[data-sp-check="true"]'
            );

        if (check) {
            check.remove();
        }

        // --------------------------------------------------------
        // Originalzustand wiederherstellen
        // --------------------------------------------------------

        row.style.opacity =
            row.dataset.spOriginalOpacity ||
            "";

        lmsTask.link.style.textDecoration =
            row.dataset.spOriginalTextDecoration ||
            "";

        delete row.dataset.spOriginalOpacity;
        delete row.dataset.spOriginalTextDecoration;

        delete lmsTask.link.dataset.spCheckAdded;
    }

    // ------------------------------------------------------------
    // Projektabgaben-Seite erkennen
    // ------------------------------------------------------------

    function isProjectAbgabenPage() {

        const headings =
            document.querySelectorAll(
                "h1"
            );

        for (
            const heading
            of headings
        ) {

            if (
                heading.textContent
                    .trim()
                    .toUpperCase() ===
                "PROJEKTABGABEN"
            ) {
                return true;
            }
        }

        return false;
    }

    // ------------------------------------------------------------
    // Statusprüfung starten
    // ------------------------------------------------------------

    function startStatusChecking() {

        if (
            statusCheckTimer !== null
        ) {
            return;
        }

        // Sofort einmal prüfen
        checkSuperProductivityStatus();

        // Danach alle 30 Sekunden
        statusCheckTimer =
            setInterval(
                checkSuperProductivityStatus,
                STATUS_CHECK_INTERVAL
            );

        console.log(
            "Super Productivity Statusprüfung gestartet."
        );
    }

    // ------------------------------------------------------------
    // Statusprüfung stoppen
    // ------------------------------------------------------------

    function stopStatusChecking() {

        if (
            statusCheckTimer === null
        ) {
            return;
        }

        clearInterval(
            statusCheckTimer
        );

        statusCheckTimer =
            null;

        console.log(
            "Super Productivity Statusprüfung gestoppt."
        );
    }

    // ------------------------------------------------------------
    // Button erstellen
    // ------------------------------------------------------------

    function createButton() {

        if (
            !isProjectAbgabenPage()
        ) {
            return;
        }

        if (
            document.getElementById(
                "sp-import-button"
            )
        ) {
            return;
        }

        const button =
            document.createElement(
                "button"
            );

        button.id =
            "sp-import-button";

        button.textContent =
            "An Super Productivity senden";

        button.type =
            "button";

        Object.assign(
            button.style,
            {
                position: "fixed",
                right: "20px",
                bottom: "20px",
                zIndex: "999999",
                padding: "10px 16px",
                background: "#333",
                color: "#fff",
                border: "1px solid #111",
                borderRadius: "4px",
                fontSize: "14px",
                fontFamily: "Arial, sans-serif",
                cursor: "pointer",
                boxShadow:
                    "0 2px 6px rgba(0,0,0,0.3)"
            }
        );

        button.addEventListener(
            "mouseenter",
            () => {
                button.style.background =
                    "#555";
            }
        );

        button.addEventListener(
            "mouseleave",
            () => {
                button.style.background =
                    "#333";
            }
        );

        button.addEventListener(
            "click",
            sendTasks
        );

        document.body.appendChild(
            button
        );
    }

    // ------------------------------------------------------------
    // Button entfernen
    // ------------------------------------------------------------

    function removeButton() {

        const button =
            document.getElementById(
                "sp-import-button"
            );

        if (button) {
            button.remove();
        }
    }

    // ------------------------------------------------------------
    // Button + Statusprüfung aktualisieren
    // ------------------------------------------------------------

    function updatePageState() {

        if (
            isProjectAbgabenPage()
        ) {

            createButton();

            startStatusChecking();

        } else {

            removeButton();

            stopStatusChecking();
        }
    }

    // ------------------------------------------------------------
    // Konfiguration
    // ------------------------------------------------------------

    async function configure() {

        const token =
            prompt(
                "Super Productivity API Token:",
                API_TOKEN
            );

        if (!token) {
            return;
        }

        API_TOKEN =
            token.trim();

        GM_setValue(
            "sp_api_token",
            API_TOKEN
        );

        try {

            await apiRequest(
                "/health"
            );

            alert(
                "Super Productivity API Verbindung erfolgreich.\n\n" +
                "Token wurde gespeichert."
            );

        } catch (error) {

            console.error(
                "Super Productivity:",
                error
            );

            alert(
                "Fehler bei der Verbindung zu Super Productivity:\n\n" +
                error.message
            );
        }
    }

    // ------------------------------------------------------------
    // LMS-Aufgaben importieren
    // ------------------------------------------------------------

    async function sendTasks() {

        if (!API_TOKEN) {

            alert(
                "Noch kein Super-Productivity API Token eingerichtet.\n\n" +
                "Bitte zuerst über das Tampermonkey-Menü konfigurieren."
            );

            return;
        }

        const tasks =
            getLmsTasks();

        if (
            tasks.length === 0
        ) {

            alert(
                "Keine Aufgaben gefunden."
            );

            return;
        }

        let projects;
        let tags;

        // --------------------------------------------------------
        // Projekte und Tags laden
        // --------------------------------------------------------

        try {

            projects =
                await getProjects();

            tags =
                await getTags();

        } catch (error) {

            console.error(error);

            alert(
                "Projekte oder Tags konnten nicht geladen werden.\n\n" +
                error.message
            );

            return;
        }

        // --------------------------------------------------------
        // Nach Prefix gruppieren
        // --------------------------------------------------------

        const groupedTasks =
            new Map();

        for (
            const task
            of tasks
        ) {

            if (
                !groupedTasks.has(
                    task.prefix
                )
            ) {

                groupedTasks.set(
                    task.prefix,
                    []
                );
            }

            groupedTasks
                .get(task.prefix)
                .push(task);
        }

        // --------------------------------------------------------
        // Übersicht
        // --------------------------------------------------------

        let overview =
            `${tasks.length} Aufgaben gefunden.\n\n`;

        for (
            const [prefix, prefixTasks]
            of groupedTasks
        ) {

            const project =
                findProject(
                    prefix,
                    projects
                );

            const tag =
                findTag(
                    prefix,
                    tags
                );

            overview +=
                `${prefix}: ${prefixTasks.length} Aufgabe(n)\n`;

            overview +=
                `  Projekt: ${
                    project
                        ? project.title
                        : "NICHT GEFUNDEN"
                }\n`;

            overview +=
                `  Tag: ${
                    tag
                        ? tag.title
                        : "NICHT VORHANDEN"
                }\n\n`;
        }

        const confirmed =
            confirm(
                overview +
                "\nImport starten?"
            );

        if (!confirmed) {
            return;
        }

        // --------------------------------------------------------
        // Statistik
        // --------------------------------------------------------

        let created = 0;

        let duplicates = 0;

        let duplicatesByUrl = 0;

        let duplicatesByTitle = 0;

        let failed = 0;

        let missingProjects = 0;

        let missingTags = 0;

        let subtasksCreated = 0;

        let urlsAdded = 0;

        // --------------------------------------------------------
        // Prefix-Gruppen verarbeiten
        // --------------------------------------------------------

        for (
            const [prefix, prefixTasks]
            of groupedTasks
        ) {

            const project =
                findProject(
                    prefix,
                    projects
                );

            if (!project) {

                console.warn(
                    `Kein Projekt für ${prefix} gefunden.`
                );

                missingProjects +=
                    prefixTasks.length;

                continue;
            }

            const tag =
                findTag(
                    prefix,
                    tags
                );

            if (!tag) {

                console.warn(
                    `Kein Tag ${prefix} gefunden.`
                );

                missingTags +=
                    prefixTasks.length;
            }

            // ----------------------------------------------------
            // Bestehende Tasks laden
            // ----------------------------------------------------

            let existingTasks;

            try {

                existingTasks =
                    await getExistingTasks(
                        project.id
                    );

            } catch (error) {

                console.error(
                    `Fehler beim Laden des Projekts ${project.title}:`,
                    error
                );

                failed +=
                    prefixTasks.length;

                continue;
            }

            // ----------------------------------------------------
            // LMS-Aufgaben verarbeiten
            // ----------------------------------------------------

            for (
                const task
                of prefixTasks
            ) {

                const existing =
                    findExistingTask(
                        task,
                        existingTasks
                    );

                // ------------------------------------------------
                // Bereits vorhanden
                // ------------------------------------------------

                if (existing) {

                    duplicates++;

                    if (
                        existing.matchedBy ===
                        "url"
                    ) {

                        duplicatesByUrl++;

                        console.log(
                            "Bereits vorhanden (URL):",
                            task.title
                        );

                    } else {

                        duplicatesByTitle++;

                        console.log(
                            "Bereits vorhanden (Titel):",
                            task.title
                        );

                        // ----------------------------------------
                        // LMS-URL ergänzen
                        // ----------------------------------------

                        try {

                            await addLmsUrlToExistingTask(
                                existing.task,
                                task.url
                            );

                            urlsAdded++;

                            console.log(
                                "LMS-URL ergänzt:",
                                task.title
                            );

                        } catch (error) {

                            console.error(
                                "LMS-URL konnte nicht ergänzt werden:",
                                task.title,
                                error
                            );
                        }
                    }

                    continue;
                }

                // ------------------------------------------------
                // Neue Aufgabe
                // ------------------------------------------------

                try {

                    console.log(
                        "Erstelle:",
                        task.title
                    );

                    const createdTask =
                        await createTask(
                            task,
                            project.id,
                            tag?.id
                        );

                    created++;

                    // --------------------------------------------
                    // Subtask "erledigt"
                    // --------------------------------------------

                    try {

                        await createDoneSubtask(
                            createdTask.id
                        );

                        subtasksCreated++;

                    } catch (error) {

                        console.error(
                            "Unteraufgabe konnte nicht erstellt werden:",
                            task.title,
                            error
                        );
                    }

                    // --------------------------------------------
                    // Lokalen Cache aktualisieren
                    // --------------------------------------------

                    existingTasks.push(
                        createdTask
                    );

                } catch (error) {

                    failed++;

                    console.error(
                        "Fehler bei:",
                        task.title,
                        error
                    );
                }
            }
        }

        // --------------------------------------------------------
        // Ergebnis
        // --------------------------------------------------------

        let result =
            "Import abgeschlossen.\n\n" +

            `Gefunden: ${tasks.length}\n` +

            `Neu erstellt: ${created}\n` +

            `Unteraufgaben erstellt: ${subtasksCreated}\n` +

            `Bereits vorhanden: ${duplicates}\n` +

            `  davon über LMS-URL: ${duplicatesByUrl}\n` +

            `  davon über Titel: ${duplicatesByTitle}\n` +

            `LMS-URLs ergänzt: ${urlsAdded}\n` +

            `Fehler: ${failed}`;

        if (
            missingProjects > 0
        ) {

            result +=
                `\nKeine passenden Projekte: ${missingProjects}`;
        }

        if (
            missingTags > 0
        ) {

            result +=
                `\nFehlende Tags: ${missingTags}`;
        }

        alert(result);

        // Nach dem Import direkt Status aktualisieren
        checkSuperProductivityStatus();
    }

    // ------------------------------------------------------------
    // Tampermonkey-Menü
    // ------------------------------------------------------------

    GM_registerMenuCommand(
        "Super Productivity konfigurieren",
        configure
    );

    // ------------------------------------------------------------
    // Initialisierung
    // ------------------------------------------------------------

    function init() {

        updatePageState();
    }

    if (
        document.readyState ===
        "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            init
        );

    } else {

        init();
    }

})();