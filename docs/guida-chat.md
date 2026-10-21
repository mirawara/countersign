# Guida alla chat Countersign (vNext personale)

Stato: prima versione personale su **Linux x64**, verificata il 21 ottobre 2026. La distribuzione a terzi richiede una decisione separata sulle condizioni d'uso dei provider. Il workflow MVP rimane disponibile dalla Command Palette; questa guida riguarda la nuova sidebar.

## Requisiti e installazione

- VS Code 1.106 o successivo; prova della sidebar e del VSIX eseguita con VS Code 1.142.0 su Linux. Workspace trusted con **una sola cartella**, radice di un repository Git. Per i turni reali il repository deve essere pulito prima del primo turno; non si eseguono reset, commit o clean automatici.
- Per la chat Claude reale: Claude CLI **2.1.109** verificata, Agent SDK **0.3.306** incluso come dipendenza dell'estensione. Il comando `claude` deve essere sul `PATH` o configurato in `countersign.claudeExecutable`. Una versione diversa resta bloccata finché l'adapter non viene riverificato; per una coppia supportata il gate di isolamento va eseguito sul computer d'uso.
- Per la chat Codex reale: Codex CLI **0.163.0** verificata e `codex app-server` disponibile. Il comando `codex` deve essere sul `PATH` o configurato in `countersign.codexExecutable`. Versioni diverse restano bloccate finché il protocollo non viene riverificato.
- Node.js e npm servono per compilare o sviluppare l'estensione, non per usare il VSIX già installato. Git e le CLI reali servono sul computer dove gira l'extension host.

Da sorgenti: `npm install`, `npm run compile`, poi avvia **Run Extension** in VS Code. Per un VSIX locale: `npm run package`, poi installa `countersign-0.1.0.vsix` con **Extensions: Install from VSIX...**. Dopo l'installazione esegui **Developer: Reload Window** nella finestra da usare. Il pacchetto usa la CLI Claude già installata e non include il binario opzionale dell'SDK.

Per aprire la chat premi **F1** (o `Ctrl+Shift+P`), digita **Countersign: Open Chat** e premi Invio. Nelle nuove installazioni la vista è nella **barra laterale destra**. Se la barra è nascosta, usa `Ctrl+Alt+B`. Le finestre che avevano già spostato Countersign possono conservare la posizione precedente: clic destro sull'icona o sull'intestazione **Countersign** → **Move To / Sposta in** → **Secondary Side Bar / Barra laterale secondaria**. VS Code conserva la posizione scelta. Se il comando non compare, controlla nel pannello Extensions che **Countersign** sia abilitata nella finestra/profilo VS Code corrente; se lavori in una finestra remota, controlla anche l'extension host remoto.

## Prima conversazione

La sidebar offre solo provider reali: la vecchia voce **Mock** non è più selezionabile. Il turno mock resta un comando interno usato dal test di integrazione sul pacchetto, non un'opzione dell'interfaccia.

1. Apri **Countersign: Open Chat** dalla Command Palette: la vista appare nella barra laterale destra, salvo una posizione personalizzata già salvata da VS Code.
2. Scegli **Provider** (Claude o Codex), **Model**, **Effort** e **Mode: Chat**, poi invia con **Send** o `Ctrl/Cmd+Invio`. Il primo invio richiede il login descritto sotto; finché un provider non è disponibile, **Send** resta disabilitato e la riga sotto i menu ne spiega il motivo.
3. I tuoi messaggi appaiono a destra, le risposte degli agenti a sinistra. Le risposte sono formattate: titoli, elenchi, citazioni, `codice in linea` e blocchi di codice con la lingua dichiarata e scorrimento orizzontale. Token, modello, effort e quota compaiono come etichette sotto il testo; l'attività dettagliata sta in **Activity**, chiusa di default.
4. Chiudi e riapri la sidebar: il thread rimane nel workspace. Usa **＋** per un thread nuovo, **✎** per rinominare, la ricerca per trovare una conversazione, **⇩** per esportare un riepilogo Markdown e **⌫** per cancellarla. **Countersign: Clear Chat History** cancella tutti i thread del workspace.

Il limite locale è di 20 thread, 200 messaggi per thread e 100.000 caratteri di testo per messaggio. Raggiunti 20 thread occorre cancellarne uno prima di crearne un altro; i messaggi più vecchi oltre il limite sono eliminati dallo store. La ricerca copre titoli e testo dei thread mantenuti.

## Login e prima chat reale

Effettua il login tramite le CLI ufficiali, ad esempio `claude auth login` e `codex login`, poi verifica con `claude auth status` e `codex login status`. Countersign usa **l'account già attivo nella CLI**, senza leggere, copiare o salvare token, cookie o API key. Se nell'ambiente sono presenti `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` o `CODEX_API_KEY`, la chat da abbonamento si blocca: rimuovile dall'ambiente dell'extension host prima di riprovare. Il login/logout e la revoca si gestiscono con i provider.

Nella sidebar seleziona Claude o Codex. Il selettore interroga la CLI e mostra i modelli e gli effort restituiti per il login attivo; **Refresh** ripete il controllo. `model/list` Codex è un catalogo: un modello elencato può ancora essere negato al momento del turno. Il valore di effort Claude e quello di reasoning Codex sono parametri distinti; `Default` lascia decidere alla CLI. L'effort effettivo compare solo se il protocollo lo riporta. L'etichetta account mostra l'email quando il provider la fornisce, altrimenti il metodo di login.

La chat conserva sia il modello richiesto sia quello effettivo quando il provider lo comunica. Una sessione nativa viene ripresa solo con lo stesso account e lo stesso modello richiesto; cambiando uno dei due parte una nuova sessione con un breve riepilogo dei messaggi precedenti.

Per Claude, esegui **Countersign: Verify Claude Chat Isolation** se la sidebar lo richiede. Il comando chiede conferma, usa due brevi turni Claude in un repository temporaneo, controlla la ripresa della sessione e che le impostazioni di progetto siano soppresse nel secondo turno. Salva solo versioni e data in `~/.countersign/claude-chat-gate.json`; un cambio versione blocca la chat fino alla riverifica dell'adapter e del gate. Il gate del vecchio workflow è separato.

Invia una richiesta nel repository di prova pulito. I tool Claude disponibili sono Read, Glob, Grep, Edit e Write; Bash, PowerShell, subagenti e accesso web non sono abilitati nella chat. Codex parte in sandbox di sola lettura con `on-request`. Se un provider chiede un permesso, la sidebar mostra l'operazione: **Allow once** autorizza quella richiesta, **Deny** la rifiuta, **Cancel turn** interrompe il turno. La chiusura della sidebar non approva nulla. Dopo una modifica, **Show diff** sul messaggio apre il diff Git salvato; un cambio esterno del repository tra turni blocca il successivo turno reale, per evitare di attribuire modifiche al provider sbagliato.

**Add file** allega il percorso del file attivo e, se presente, fino a 8.000 caratteri della selezione al prossimo prompt. È un riferimento testuale: immagini e altri allegati binari non sono ancora supportati. Il file e l'eventuale destinazione di un collegamento simbolico devono essere nel workspace. Prima di inviare testo selezionato, verifica che non contenga segreti.

## Modalità e workflow Balanced

**Chat (one provider)** manda un turno al provider scelto; puoi passare da Claude a Codex nel thread. **Add mode** crea una modalità chat con nome, istruzione e timeout per turno (1–60 minuti); **Delete mode** rimuove una modalità personalizzata. Ogni messaggio registra il nome della modalità scelta. Il timeout e l'istruzione sono fissati quando parte il turno; modificare o eliminare la modalità dopo non cambia il turno già avviato.

**Claude + Codex (Balanced)** dalla sidebar usa gli agenti reali Claude e Codex. La scelta dei modelli vale solo per il task e non cambia le impostazioni globali. Ci sono quattro selettori: **modello ed effort Claude** e **modello e reasoning effort Codex**. **Default (CLI)** lascia decidere alla rispettiva CLI; per specificare un effort occorre scegliere un modello. Il passaggio a Balanced carica i cataloghi; **Refresh** li aggiorna. Il modello elencato può comunque essere negato dal provider al momento della richiesta. Tool, controlli locali e timeout continuano a provenire dalle impostazioni VS Code.

Dopo **Start workflow**, Claude prepara un piano con soli strumenti di lettura. Se gli manca una decisione necessaria, la domanda compare nel thread: scrivi la risposta nel riquadro **Send answer**. Il piano e i dettagli di esecuzione appaiono poi nel thread; **Approve plan** avvia le modifiche, **Cancel workflow** interrompe senza avviare l'implementazione. Il vecchio popup modale non viene usato per l'approvazione dalla sidebar. Il comando **Countersign: Start Workflow** dalla Command Palette conserva invece la propria conferma modale e usa le impostazioni globali dei provider.

Durante implementazione, review o correzione, un agente può restituire una domanda. Il workflow si ferma tra due invocazioni CLI e riprende dopo la risposta nella chat. Se ci sono già modifiche parziali, le conserva e verifica che il diff Git non sia cambiato mentre aspetta. Una domanda non può interrompere un singolo tool già in corso. Sono ammesse al massimo tre domande nella pianificazione e tre per ciascuna fase di esecuzione; raggiunto il limite il workflow si ferma con il motivo visibile. **Stop** o **Cancel workflow** interrompono l'attesa. Non modificare il repository mentre Countersign aspetta una risposta.

Al termine la chat conserva un **report dettagliato**: piano approvato, domande e risposte, cronologia delle fasi, file modificati, controlli con esito e parte dell'output, review con finding e prove, correzione e uso riportato dai provider. **Show diff** sul report apre la patch salvata. Il report limita la lunghezza di output e finding molto grandi; i comandi **Show Review Details** e **Show Check Results** mostrano i dettagli completi. Claude implementa, Codex revisiona il diff e Claude può fare un solo passaggio di correzione; non è ancora il dialogo fino al consenso previsto per `Strict`. La sidebar segnala se un task Countersign occupa il repository e disabilita l'invio di un altro task reale. Il lock vale nello stesso extension host; finestre VS Code separate non sono ancora coordinate.

## Quote, sessioni e cancellazione

Claude può riportare stato della quota dell'abbonamento (`allowed`, `allowed_warning`, `rejected`); per Codex e negli altri casi appare **Unavailable**. I token e i valori in USD sono dati riportati dall'SDK: gli USD sono **stime a tariffa API, non un addebito sul tuo abbonamento né un tetto di spesa**. A un limite d'uso il turno si ferma; non avviene alcun cambio automatico di account. La v1 usa un solo account attivo per provider; profili multipli, cambio automatico e `Strict` restano fuori.

I thread, le modalità e i riferimenti alle sessioni native stanno nel `workspaceState` di VS Code. La riapertura della sidebar è verificata nel VSIX; la ricostruzione dello store da dati salvati è coperta dai test, ma il riavvio completo di una normale finestra VS Code non è stato ancora provato automaticamente. I diff sono file locali nella storage area del workspace dell'estensione. Possono contenere codice sensibile. La cancellazione di un thread o **Clear Chat History** elimina messaggi e diff di Countersign; le sessioni native restano nelle directory gestite da Claude e Codex. Per eliminare anche quelle, usa i controlli di cronologia/sessione del provider o la sua procedura ufficiale. Cancellare `~/.countersign/claude-chat-gate.json` revoca il gate della chat, senza effettuare logout. Un turno fallito o interrotto può lasciare modifiche parziali nel repository: controlla `git status` e il diff prima di ripartire.

## Limiti e diagnostica

- Linux x64 è l'unica piattaforma vNext verificata. Windows resta bloccato per la cancellazione dell'albero dei processi; macOS richiede le sue prove.
- `codex app-server` nella versione scelta è sperimentale; una versione diversa chiude la chat Codex. Il vecchio adapter `codex exec` rimane nel workflow Balanced.
- Le impostazioni gestite dall'organizzazione e le capacità effettive del singolo modello possono restringere ulteriormente tool e accesso. Un login Claude da abbonamento nella CLI non certifica la fatturazione futura. La distribuzione a terzi con login Claude richiede chiarimento dei termini Anthropic.
- La chat salva un diff Git cumulativo rispetto a `HEAD` dopo un turno che modifica file. File ignorati da Git, binari e percorsi esclusi non sono inclusi; il provider può comunque averli toccati. Il collector blocca diff non revisionabili. I check locali automatici appartengono a Balanced, non alla modalità Chat libera.
- Se un provider non appare, verifica workspace trusted, una sola cartella Git, versioni CLI, login ufficiale e variabili API key; poi premi **Refresh**. Per il vecchio workflow usa **Show Diagnostics**. La chat non scrive prompt, credenziali o diff nell'Output Channel.

Le prove live riproducibili sono in `scripts/smoke-chat-adapters.mjs`, `scripts/smoke-chat-write.mjs` e `scripts/smoke-codex-approval.mjs`; richiedono `--live`, consumano quota e usano solo repository temporanei. `npm test` e il caso integrato `chat-mock` non inviano prompt reali.
