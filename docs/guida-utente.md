# Guida utente — workflow MVP Countersign

Per la nuova sidebar chat, leggi [guida-chat.md](guida-chat.md). Questa pagina descrive il workflow originale avviato dalla Command Palette.

## Che cosa si apre in VS Code

Questo percorso non usa la chat. Avvii un comando dalla Command Palette, scrivi un task in una casella di input e confermi l'esecuzione in una finestra modale. L'avanzamento appare nel pannello **Output → Countersign**; altri comandi aprono il diff, la review e l'output dei controlli in documenti temporanei dell'editor.

Ogni avvio è un workflow separato. Non ci sono conversazioni, messaggi successivi, allegati o un pannello laterale dedicato. L'estensione conserva in memoria solo il risultato più recente nella sessione corrente di VS Code. Le estensioni [Codex per IDE](https://learn.chatgpt.com/docs/codex/ide) e [Claude Code per VS Code](https://code.claude.com/docs/en/vs-code) offrono invece un'interazione conversazionale più ampia. Questo MVP serve a eseguire un percorso preciso: implementazione con Claude, controlli configurati, review con Codex ed eventuale singola correzione.

## Requisiti

| Per cosa | Serve |
| --- | --- |
| Tutte le modalità | VS Code desktop **1.95.0 o successivo**, Git disponibile nel `PATH`, una sola cartella aperta che sia la radice di un repository Git considerato attendibile da VS Code. Il repository deve avere lo stato Git pulito, inclusi i file non tracciati. |
| Prima prova mock | Nessuna CLI AI e nessun account AI. Le impostazioni predefinite sono entrambe `mock`. I controlli locali sono vuoti per impostazione predefinita. |
| Workflow reale | Claude Code CLI e Codex CLI installate, raggiungibili dall'extension host e già autenticate nei rispettivi account. Le CLI devono esporre i flag richiesti dall'estensione. L'estensione non esegue il login. |
| Controlli locali | Gli eseguibili scelti nei controlli, per esempio `node` o `npm`, disponibili nel `PATH` dell'extension host. |
| Piattaforma | Validato su Linux. macOS non è ancora stato verificato con il test di cancellazione. L'avvio del workflow su Windows è bloccato dal codice. |

Non serve installare Node.js per eseguire il VSIX in modalità mock senza controlli locali. Node.js e npm servono per sviluppare l'estensione dai sorgenti o se li scegli come controlli.

## Modalità disponibili

| Implementazione | Review | Effetto |
| --- | --- | --- |
| `mock` | `mock` | Prova predefinita senza richieste AI; modifiche simulate in memoria. |
| `mock` | `real` | Codex rivede un diff simulato; consuma quota, ma non esamina una modifica reale. |
| `claude` | `real` | Claude modifica il repository, vengono eseguiti i controlli configurati e Codex rivede il diff Git. |

La combinazione `claude` + `mock` non è consentita. I valori delle modalità si impostano con `countersign.provider` e `countersign.codexProvider`.

## Installazione

Se hai il file `.vsix`, in VS Code apri la Command Palette (`Ctrl+Shift+P` su Linux/Windows, `Cmd+Shift+P` su macOS), esegui **Extensions: Install from VSIX...** e seleziona il file. Ricarica la finestra se VS Code lo richiede. Cerca **Countersign** nella lista delle estensioni installate.

Il VSIX non è incluso nel repository Git. Per provarla dai sorgenti, apri questa cartella in VS Code, esegui `npm ci`, poi avvia la configurazione **Run Countersign** con `F5`. Nell'Extension Development Host apri il repository Git su cui vuoi fare la prova. Per build e test del progetto vedi il [README](../README.md#development).

## Prima prova senza richieste AI

1. Apri in VS Code la radice di un piccolo repository Git di prova, diverso da quello dell'estensione, e concedi Workspace Trust.
2. Controlla con `git status --short` che non ci siano modifiche. Se hai file da conservare, sistemali prima di avviare il workflow; l'estensione non li pulisce.
3. Lascia le impostazioni predefinite: `countersign.provider = mock` e `countersign.codexProvider = mock`.
4. Apri la Command Palette, cerca **Countersign: Start Workflow**, inserisci un task e conferma dopo aver letto repository, task e controlli mostrati nella finestra modale.
5. Apri **Output → Countersign** e usa **Show Workflow Status**, **Show Workflow Diff**, **Show Review Details** e **Show Check Results** per vedere i dettagli.

Con i valori predefiniti, il diff è simulato in memoria: Claude e Codex non vengono chiamati e i provider mock non modificano i file. Se configuri controlli locali, questi sono processi reali e possono modificare il repository anche durante una prova mock; in quel caso il workflow segnala `validation_failed`.

## Attivare Claude e Codex reali

1. Verifica nel terminale integrato che `claude --version` e `codex --version` funzionino. Se VS Code è stato avviato con un `PATH` diverso da quello del terminale, imposta i percorsi completi in `countersign.claudeExecutable` e `countersign.codexExecutable`.
2. Apri **Preferences: Open User Settings (JSON)** e imposta, per esempio:

   ```json
   {
     "countersign.provider": "claude",
     "countersign.codexProvider": "real",
     "countersign.localChecks": [
       { "id": "tests", "executable": "node", "args": ["--test"] }
     ]
   }
   ```

   Adatta `localChecks` ai comandi del tuo repository. L'estensione non scopre né avvia test da sola: con la lista vuota non esegue alcun controllo. I controlli usano eseguibile e argomenti separati, senza shell. Le impostazioni utente evitano di creare un nuovo `.vscode/settings.json` non tracciato nel repository da verificare.
3. Esegui **Countersign: Verify Claude Settings Isolation**. Dopo la tua conferma parte un test controllato con **due richieste reali a Claude**. Se passa, il risultato vale solo per la versione esatta della CLI Claude installata; dopo un aggiornamento devi ripeterlo. La verifica può consumare quota.
4. Assicurati che il repository sia pulito e avvia **Start Workflow**. La conferma mostra repository, task, tool concessi a Claude, controlli e provider. Accettala solo dopo aver verificato questi dati. Il run reale può consumare quota di entrambi gli account.
5. Segui l'avanzamento nell'Output Channel. Al termine apri diff, review e risultati dei controlli; confronta anche `git diff` e `git status` prima di conservare le modifiche. L'estensione non fa commit, stage, reset o pulizia del repository.

In modalità reale Claude può usare solo `Read`, `Glob`, `Grep`, `Edit` e `Write`, secondo l'allowlist confermata. Non usa Bash; i controlli locali vengono avviati separatamente dall'estensione. Codex esamina il diff in una sandbox di sola lettura e può leggere file del repository come contesto. Non sono usate API dirette dei provider.

### Cosa succede se un controllo o la review trova un problema

- Se un controllo locale fallisce, lo stato diventa `validation_failed`: il workflow si ferma e **non** rimanda automaticamente l'errore a Claude.
- Se Codex segnala un finding eleggibile, Claude può fare **una sola** correzione; poi i controlli vengono ripetuti. Non segue una seconda review Codex. In questo percorso `completed_clean` indica che la correzione è stata dichiarata risolta e i controlli sono passati, non che Codex abbia verificato il diff corretto.
- Dopo un run reale il repository normalmente contiene modifiche. Per avviare un nuovo workflow devi prima riportarlo a uno stato Git pulito in modo consapevole, per esempio conservando le modifiche in un commit. Non c'è un messaggio di follow-up sul run precedente.

## Comandi disponibili

Aprili dalla Command Palette cercando **Countersign**.

| Comando | Uso |
| --- | --- |
| **Start Workflow** | Inserisce il task, chiede conferma e avvia il workflow. |
| **Cancel Workflow** | Richiede l'arresto del workflow attivo; un run reale può lasciare modifiche parziali da controllare con Git. |
| **Show Workflow Status** | Mostra stato corrente e ultimo esito. |
| **Show Workflow Diff** | Apre il diff reale o simulato dell'ultimo risultato. |
| **Show Review Details** | Apre riepilogo e finding dell'ultima review. |
| **Show Check Results** | Apre esiti e output dei controlli configurati. |
| **Show Diagnostics** | Scrive nell'Output Channel versioni e stato diagnostico, senza leggere le credenziali. |
| **Verify Claude Settings Isolation** | Esegue il gate richiesto per usare Claude reale. |

## Interpretare gli esiti

| Stato | Significato pratico |
| --- | --- |
| `completed_clean` | Il percorso previsto è terminato senza finding residui segnalati; controlla se erano configurati test e se c'è stata una correzione non rivista da Codex. |
| `completed_with_findings` | Sono rimasti finding da leggere in **Show Review Details**. |
| `validation_failed` | Almeno un controllo è fallito oppure un controllo ha modificato il repository in modalità mock. |
| `blocked_dirty_repository` | Git vede modifiche o file non tracciati prima della partenza. |
| `blocked_provider` / `blocked_auth_or_quota` | Controlla CLI, versione, gate Claude, autenticazione e disponibilità degli account. |
| `cancelled` / `timed_out` | Il workflow è stato interrotto; controlla lo stato Git prima di riprovare. |
| `review_failed` / `failed` | Consulta l'Output Channel e **Show Diagnostics** per il motivo registrato. |

L'Output Channel mostra stati e riepiloghi, non il prompt completo, il diff integrale o l'output grezzo dei controlli. I documenti aperti dai comandi di dettaglio possono contenere codice o informazioni sensibili: chiudili quando hai finito. I file ignorati da Git non entrano nel normale diff e nella review. `completed_clean` senza controlli configurati non prova che build o test siano passati.
