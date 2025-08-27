//@target aftereffects
/*  Whisper Auto Subtitles (ScriptUI Panel) - Windows/Mac
    Requirements:
      - Run as ScriptUI Panel (ExtendScript). system.callSystem() must exist.
      - Whisper CLI in PATH (test in cmd: whisper --help)
      - ffmpeg installed (whisper requires it)
    Features:
      - Uses selected footage layer's source file
      - Model + Language selection
      - Choose output folder for transcripts
      - Transcribe & Import with one click
      - If SRT missing, auto-makes SRT from Whisper .txt (timed to layer/comp duration)
      - Manual SRT import
      - Subtitle editor (based on user's provided editor)
*/

(function WhisperAutoSubtitlesPanel() {

    // ---------------------------
    // Utilities
    // ---------------------------
    function isWindows() { return $.os.toLowerCase().indexOf('windows') !== -1; }

    function quotePath(p) {
        // Use double quotes, escape internal quotes
        return '"' + String(p).replace(/"/g, '\\"') + '"';
    }

    function pad2(n) { return ('00' + n).slice(-2); }
    function pad3(n) { return ('000' + n).slice(-3); }

    function formatSRTTime(seconds) {
        if (seconds < 0) seconds = 0;
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        var ms = Math.round((seconds - Math.floor(seconds)) * 1000);
        return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "," + pad3(ms);
    }

    function parseSRTTime(t) {
        // "HH:MM:SS,mmm"
        var parts = t.trim().split(":");
        if (parts.length < 3) return 0;
        var secParts = parts[2].split(",");
        var h = parseInt(parts[0], 10) || 0;
        var m = parseInt(parts[1], 10) || 0;
        var s = parseInt(secParts[0], 10) || 0;
        var ms = parseInt(secParts[1], 10) || 0;
        return h * 3600 + m * 60 + s + ms / 1000;
    }

    function secondsToFrames(time, comp) { return time * (1.0 / comp.frameDuration); }
    function framesToSeconds(frames, comp) { return frames / (1.0 / comp.frameDuration); }

    function TimeStringToSeconds(timeInString) {
        // Accept "HH:MM:SS,mmm"
        var t = timeInString.split(":");
        var s = parseInt(t[0], 10) * 3600 + parseInt(t[1], 10) * 60 + parseFloat(t[2].replace(",", "."));
        return s;
    }

    function splitTranscriptToLines(txt) {
        // Robust-ish split: first by double newlines, then by sentence punctuation if needed
        var lines = [];
        txt = (txt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        if (!txt) return lines;

        var blocks = txt.split(/\n{2,}/);
        for (var b = 0; b < blocks.length; b++) {
            var block = blocks[b].trim();
            if (!block) continue;
            // If block is very long, split by sentence punctuation
            if (block.length > 140) {
                var segs = block.split(/(?<=[\.\!\?])\s+/);
                for (var s = 0; s < segs.length; s++) {
                    var seg = segs[s].trim();
                    if (seg) lines.push(seg);
                }
            } else {
                lines.push(block);
            }
        }
        // If still a single very long line, hard wrap ~80 chars
        var wrapped = [];
        for (var i = 0; i < lines.length; i++) {
            var L = lines[i];
            if (L.length <= 90) { wrapped.push(L); continue; }
            var words = L.split(/\s+/);
            var curr = "";
            for (var w = 0; w < words.length; w++) {
                var tryAdd = (curr ? curr + " " : "") + words[w];
                if (tryAdd.length > 90) { wrapped.push(curr); curr = words[w]; }
                else curr = tryAdd;
            }
            if (curr) wrapped.push(curr);
        }
        return wrapped;
    }

    function writeTextFile(fileObj, content) {
        fileObj.encoding = "UTF-8";
        fileObj.open("w");
        fileObj.write(content);
        fileObj.close();
    }

    function readTextFile(fileObj) {
        if (!fileObj.exists) return "";
        fileObj.open("r");
        var t = fileObj.read();
        fileObj.close();
        return t;
    }

    function findCompActive() {
        var comp = app.project && app.project.activeItem;
        if (comp && comp instanceof CompItem) return comp;
        return null;
    }

    function findSelectedFootageLayer(comp) {
        if (!comp || !comp.selectedLayers || comp.selectedLayers.length === 0) return null;
        var ly = comp.selectedLayers[0];
        if (ly && ly.source && ly.source instanceof FootageItem && ly.source.file) return ly;
        return null;
    }

    function buildWhisperCommand(mediaPath, outDir, model, language, fmt) {
		var cmdCore = 'whisper ' + quotePath(mediaPath) +
					' --model ' + model +
					' --language ' + language +
					' --output_format ' + fmt +
					(outDir ? (' --output_dir ' + quotePath(outDir)) : '');

		if (isWindows()) {
			return 'cmd /c ' + cmdCore;   // ✅ no quotes around whole command
		} else {
			return '/bin/bash -lc ' + quotePath(cmdCore);
		}
	}


    function runSystem(cmd) {
        // Wrap system.callSystem (block and return stdout)
        return system.callSystem(cmd);
    }

    function makeSRTFromTXT(txtContent, srtFile, totalDurationSec) {
        var lines = splitTranscriptToLines(txtContent);
        if (lines.length === 0) return false;

        // Evenly distribute across totalDurationSec (fallback to 3s/line if totalDuration unknown)
        var per = totalDurationSec && totalDurationSec > 0 ? (totalDurationSec / lines.length) : 3.0;
        if (per < 1.5) per = 1.5; // don’t go too tiny

        var t = 0.0, idx = 1;
        var out = "";
        for (var i = 0; i < lines.length; i++) {
            var start = formatSRTTime(t);
            var end = formatSRTTime(t + per);
            out += (idx++) + "\n" + start + " --> " + end + "\n" + lines[i] + "\n\n";
            t += per;
        }
        writeTextFile(srtFile, out);
        return true;
    }

    // ---------------------------
    // Subtitle Importer (based on user's provided ImportSRT + editor)
    // ---------------------------
    function ImportSRTFileIntoComp(srtFile, comp) {
        if (!(comp && comp instanceof CompItem)) { alert("Please select a composition first."); return; }
        if (!srtFile || !srtFile.exists) { alert("SRT file not found."); return; }

        app.beginUndoGroup("Import SRT Subtitles");

        srtFile.open("r");
        while (!srtFile.eof) {
            var line = srtFile.readln();
            // skip blank lines before index
            while (line === "" && !srtFile.eof) line = srtFile.readln();
            if (srtFile.eof) break;

            // index (not used)
            // read timing
            var timeLine = srtFile.readln();
            if (!timeLine || timeLine.indexOf("-->") === -1) {
                // malformed; try keep going
                continue;
            }
            var times = timeLine.split("-->");
            var f = TimeStringToSeconds(times[0]);
            var l = TimeStringToSeconds(times[1]);

            // text lines
            var text = "";
            var txtLine;
            while (!srtFile.eof && (txtLine = srtFile.readln()) !== "") {
                text += txtLine.replace(/<(.*?)>/g, "") + "\r\n";
            }

            // Create text layer
            var layer = comp.layers.addText(text);
            var inFrame = secondsToFrames(f, comp);
            var outFrame = secondsToFrames(l, comp);
            var inTime = framesToSeconds(Math.round(inFrame), comp);
            var outTime = framesToSeconds(Math.round(outFrame), comp);
            layer.inPoint = inTime;
            layer.outPoint = outTime;
            layer.property("ADBE Transform Group").property("ADBE Position")
                 .setValue([comp.width/2, comp.height - 100]);
        }
        srtFile.close();

        app.endUndoGroup();
    }

    // ---- Subtitle Editor (ported from user's script, compacted but same logic) ----
    function formatTimeSimple(seconds) {
        var h = Math.floor(seconds/3600);
        var m = Math.floor((seconds%3600)/60);
        var s = Math.floor(seconds%60);
        return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    }

    function showEditor() {
        var comp = findCompActive();
        if (!(comp instanceof CompItem)) { alert("Please select a composition first."); return; }

        var editorWin = new Window("palette", "Subtitle Editor");
        editorWin.orientation = "column";
        editorWin.alignChildren = ["fill","top"];
        editorWin.spacing = 10; editorWin.margins = 16;

        var listPanel = editorWin.add("panel", undefined, "Subtitles");
        listPanel.alignChildren = ["fill","top"];
        var subtitleList = listPanel.add("listbox", undefined, [], {multiselect:false});
        subtitleList.preferredSize.height = 140; subtitleList.preferredSize.width = 260;

        var editPanel = editorWin.add("panel", undefined, "Edit Subtitle");
        editPanel.alignChildren = ["fill","top"]; editPanel.spacing = 5;

        var textArea = editPanel.add("edittext", undefined, "", {multiline:true});
        textArea.preferredSize.height = 80;

        var timingGroup = editPanel.add("group");
        timingGroup.orientation = "row"; timingGroup.spacing = 5;
        timingGroup.add("statictext", undefined, "In:");
        var inTime = timingGroup.add("edittext", undefined, "00:00:00,000"); inTime.characters = 12;
        timingGroup.add("statictext", undefined, "Out:");
        var outTime = timingGroup.add("edittext", undefined, "00:00:00,000"); outTime.characters = 12;

        var btnGroup = editPanel.add("group"); btnGroup.orientation = "row"; btnGroup.spacing = 10;
        var updateBtn = btnGroup.add("button", undefined, "Update");
        var refreshBtn = btnGroup.add("button", undefined, "Refresh List");

        function collectTextLayersBottomToTop() {
            var arr = [];
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                if (L instanceof TextLayer) {
                    arr.unshift(L); // bottom-to-top order in list
                }
            }
            return arr;
        }

        function refreshSubtitleList() {
            subtitleList.removeAll();
            var layers = collectTextLayersBottomToTop();
            for (var j = 0; j < layers.length; j++) {
                var L = layers[j];
                var display = formatTimeSimple(L.inPoint) + " > " +
                              formatTimeSimple(L.outPoint) + " | " +
                              (L.property("Source Text").value.text.split("\r\n")[0] || "");
                subtitleList.add("item", display);
            }
        }

        function updateSubtitle() {
            if (!subtitleList.selection) { alert("Select a subtitle to update."); return; }
            app.beginUndoGroup("Update Subtitle");
            try {
                var layers = collectTextLayersBottomToTop();
                var L = layers[subtitleList.selection.index];
                if (L) {
                    var textProp = L.property("Source Text");
                    var td = textProp.value;
                    td.text = textArea.text;
                    textProp.setValue(td);
                    L.inPoint = parseSRTTime(inTime.text);
                    L.outPoint = parseSRTTime(outTime.text);
                    refreshSubtitleList();
                }
            } catch(e) { alert("Error updating: " + e.toString()); }
            app.endUndoGroup();
        }

        subtitleList.onChange = function() {
            if (!subtitleList.selection) return;
            var layers = collectTextLayersBottomToTop();
            var L = layers[subtitleList.selection.index];
            if (L) {
                textArea.text = L.property("Source Text").value.text;
                inTime.text = formatSRTTime(L.inPoint);
                outTime.text = formatSRTTime(L.outPoint);
            }
        };

        updateBtn.onClick = updateSubtitle;
        refreshBtn.onClick = refreshSubtitleList;

        refreshSubtitleList();
        editorWin.center(); editorWin.show();
    }

    function openYouTube() {
        try {
            if (isWindows()) {
                system.callSystem('cmd /c start "" ' + quotePath('https://www.youtube.com/c/PUSHKARFF'));
            } else {
                system.callSystem('/usr/bin/open ' + quotePath('https://www.youtube.com/c/PUSHKARFF'));
            }
        } catch (e) {}
    }

    // ---------------------------
    // ScriptUI Panel
    // ---------------------------
    function buildUI(thisObj) {
        var panel = (thisObj instanceof Panel) ? thisObj : new Window("palette", "Whisper Auto Subtitles", undefined, {resizeable:true});
        panel.orientation = "column";
        panel.alignChildren = ["fill", "top"];
        panel.spacing = 10;
        panel.margins = 12;

        // Whisper Controls
        var whisperPanel = panel.add("panel", undefined, "Whisper Transcription");
        whisperPanel.orientation = "column"; whisperPanel.alignChildren = ["fill","top"];
        whisperPanel.margins = 10; whisperPanel.spacing = 6;

        var row1 = whisperPanel.add("group"); row1.orientation = "row";
        row1.add("statictext", undefined, "Model:");
        var modelDD = row1.add("dropdownlist", undefined, ["tiny","base","small","medium","large"]);
        modelDD.selection = 3; // medium default
        row1.add("statictext", undefined, "Language:");
        var langET = row1.add("edittext", undefined, "English"); langET.characters = 12;

        var row2 = whisperPanel.add("group"); row2.orientation = "row";
        row2.add("statictext", undefined, "Output Folder:");
        var outET = row2.add("edittext", undefined, ""); outET.characters = 34;
        var outBtn = row2.add("button", undefined, "Browse");

        var row3 = whisperPanel.add("group"); row3.orientation = "row"; row3.alignChildren = ["left","center"];
        var transcribeBtn = row3.add("button", undefined, "Transcribe & Import");
        var refreshSelBtn = row3.add("button", undefined, "Use Selected Layer");
        var statusST = whisperPanel.add("statictext", undefined, "Status: Idle");
        statusST.characters = 60;

        // SRT Tools
        var srtGroup = panel.add("group");
        srtGroup.orientation = "row"; srtGroup.spacing = 10; srtGroup.alignChildren = ["fill","center"];
        var importBtn = srtGroup.add("button", undefined, "Import SRT");
        var editorBtn = srtGroup.add("button", undefined, "Open Editor");

        var separator = panel.add("panel"); separator.alignment = "fill"; separator.height = 2;

        var socialGroup = panel.add("group");
        socialGroup.orientation = "row"; socialGroup.spacing = 10; socialGroup.alignChildren = ["center","center"];
        var ytBtn = socialGroup.add("button", undefined, "PUSHKAR");
        ytBtn.preferredSize.width = 150; ytBtn.preferredSize.height = 30;

        // --- Handlers ---
        outBtn.onClick = function() {
            var f = Folder.selectDialog("Choose output folder for transcripts");
            if (f) outET.text = f.fsName;
        };

        refreshSelBtn.onClick = function() {
            var comp = findCompActive();
            var ly = comp ? findSelectedFootageLayer(comp) : null;
            if (!ly) { alert("Select a footage layer in the active comp."); return; }
            var mediaFolder = ly.source.file.parent.fsName;
            if (!outET.text) outET.text = mediaFolder;
            statusST.text = "Selected: " + ly.source.file.fsName;
        };

        function runWhisperAndImport() {
            var comp = findCompActive();
            if (!(comp && comp instanceof CompItem)) { alert("Make a comp active (select it)."); return; }
            var ly = findSelectedFootageLayer(comp);
            if (!ly) { alert("Select a footage layer (video/audio) in the active comp."); return; }

            var mediaPath = ly.source.file.fsName;
            var mediaFile = new File(mediaPath);
            var outDir = outET.text || mediaFile.parent.fsName;
            var model = (modelDD.selection && modelDD.selection.text) ? modelDD.selection.text : "medium";
            var language = langET.text || "English";
            var fmt = "srt";

            statusST.text = "Running Whisper... this will block AE until finished.";
            var cmd = buildWhisperCommand(mediaPath, outDir, model, language, fmt);

            var sysOut = "";
            try {
                sysOut = runSystem(cmd);
            } catch (e) {
                alert("Failed to run Whisper.\n" + e.toString() + "\n\nCommand:\n" + cmd);
                statusST.text = "Status: Whisper failed.";
                return;
            }

            // Expected output filename
            var baseName = mediaFile.name.replace(/\.[^\.]+$/, "");
            var srtFile = new File(outDir + "/" + baseName + ".srt");
            var txtFile = new File(outDir + "/" + baseName + ".txt");

            if (!srtFile.exists) {
                // Try to build SRT from TXT
                var txtContent = readTextFile(txtFile);
                if (txtContent && txtContent.replace(/\s+/g, '').length > 0) {
                    // Duration for auto-timing: use selected layer's duration inside comp
                    var totalDur = Math.max(ly.outPoint - ly.inPoint, comp.duration);
                    var ok = makeSRTFromTXT(txtContent, srtFile, totalDur);
                    if (!ok || !srtFile.exists) {
                        alert("Whisper did not create .srt, and failed to build SRT from .txt.");
                        statusST.text = "Status: No SRT created.";
                        return;
                    }
                    statusST.text = "Built SRT from TXT (auto-timed).";
                } else {
                    // As a last resort, try to parse stdout text (some whisper builds print transcript)
                    if (sysOut && sysOut.replace(/\s+/g, '').length > 0) {
                        var totalDur2 = Math.max(ly.outPoint - ly.inPoint, comp.duration);
                        var ok2 = makeSRTFromTXT(sysOut, srtFile, totalDur2);
                        if (!ok2 || !srtFile.exists) {
                            alert("No .srt found. Check Whisper CLI or set output folder.\n\nCommand:\n" + cmd);
                            statusST.text = "Status: No SRT created.";
                            return;
                        }
                        statusST.text = "Built SRT from Whisper output (auto-timed).";
                    } else {
                        alert("No .srt or transcript text found.\nPlease ensure Whisper is installed and --output_dir is writable.");
                        statusST.text = "Status: No SRT created.";
                        return;
                    }
                }
            } else {
                statusST.text = "Found SRT: " + srtFile.fsName;
            }

            // Import into comp
            try {
                ImportSRTFileIntoComp(srtFile, comp);
                statusST.text = "Imported subtitles from " + srtFile.displayName;
            } catch (impErr) {
                alert("Failed to import SRT: " + impErr.toString());
                statusST.text = "Status: Import failed.";
            }
        }

        transcribeBtn.onClick = runWhisperAndImport;

        importBtn.onClick = function() {
            var srt = File.openDialog("Select SRT file to import", "*.srt");
            var comp = findCompActive();
            if (srt && comp) {
                ImportSRTFileIntoComp(srt, comp);
            } else if (!comp) {
                alert("Please select a composition first.");
            }
        };

        editorBtn.onClick = showEditor;
        ytBtn.onClick = openYouTube;

        panel.onResizing = panel.onResize = function() { this.layout.resize(); };
        panel.layout.layout(true);
        return panel;
    }

    var ui = buildUI(this);
    if (ui instanceof Window) { ui.center(); ui.show(); }

})();
