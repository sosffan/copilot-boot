(function () {
    const vscode = acquireVsCodeApi();

    // Elements - Pages
    const homePage = document.getElementById('home-page');
    const createPage = document.getElementById('create-page');

    // Elements - Home
    const instructionList = document.getElementById('instruction-list');
    const btnGoToCreate = document.getElementById('go-to-create');

    // Elements - Create Form
    const btnBackToHome = document.getElementById('back-to-home');
    const btnSave = document.getElementById('save-instruction');
    const inputName = document.getElementById('inst-name');
    const inputDesc = document.getElementById('inst-desc');
    const nameError = document.getElementById('name-error');
    const selectType = document.getElementById('inst-type');
    const mappingContainer = document.getElementById('mapping-container');
    const multiSelectMapping = document.getElementById('inst-mapping');
    const createErrorBanner = document.getElementById('create-error-banner');

    // Global state
    let toolConfigs = [];
    let currentInstructions = [];

    // 1. Initial Data Request
    vscode.postMessage({ type: 'requestData' });

    // 2. Navigation
    function showCreatePage() {
        homePage.classList.add('hidden');
        createPage.classList.remove('hidden');
    }

    function showHomePage() {
        createPage.classList.add('hidden');
        homePage.classList.remove('hidden');
        resetCreateForm();
    }

    function showCreateError(message) {
        createErrorBanner.textContent = message;
        createErrorBanner.style.display = 'block';
    }

    btnGoToCreate.addEventListener('click', showCreatePage);

    btnBackToHome.addEventListener('click', (e) => {
        e.preventDefault(); // Handle if it's an anchor tag
        showHomePage();
    });

    // 3. Form Logic
    function validateForm() {
        const name = inputName.value.trim();
        const toolId = selectType.value;
        const nameRegex = /^[a-zA-Z0-9\-_]+$/;

        const isNameValid = nameRegex.test(name);
        nameError.style.display = (name && !isNameValid) ? 'block' : 'none';

        // Clear creation error when user fixes the name
        createErrorBanner.style.display = 'none';

        btnSave.disabled = !name || !isNameValid || !toolId;
    }

    inputName.addEventListener('input', validateForm);

    selectType.addEventListener('change', (e) => {
        const selectedId = e.target.value;
        const tool = toolConfigs.find(t => t.id === selectedId);

        if (tool && tool.mappings) {
            renderMappings(tool.mappings);
            mappingContainer.classList.remove('hidden');
        } else {
            mappingContainer.classList.add('hidden');
        }
        validateForm();
    });

    btnSave.addEventListener('click', () => {
        const name = inputName.value.trim();
        const description = inputDesc.value.trim();
        const toolId = selectType.value;

        if (!name || !toolId) return;

        const selectedMappings = Array.from(multiSelectMapping.querySelectorAll('vscode-option'))
            .filter(opt => opt.selected)
            .map(opt => opt.value);

        vscode.postMessage({
            type: 'create',
            name,
            description,
            toolId,
            mappings: selectedMappings
        });

        // DO NOT showHomePage() here. 
        // We stay on the page until we get an 'update' (success) or 'createError' (failure).
    });

    // 4. Message Handling
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'update':
                toolConfigs = message.availableTools || [];
                currentInstructions = message.instructions || [];

                updateToolDropdown(toolConfigs);
                renderInstructions(
                    currentInstructions,
                    message.selected,
                    message.availableTools
                );

                // If we were on the create page, go back home now that it's finished
                if (!createPage.classList.contains('hidden')) {
                    showHomePage();
                }
                break;
            case 'createError':
                showCreateError(message.message);
                break;
        }
    });

    // 5. Rendering & Component Logic
    function updateToolDropdown(tools) {
        selectType.innerHTML = '<vscode-option value="">Select a tool...</vscode-option>';
        tools.forEach(tool => {
            const opt = document.createElement('vscode-option');
            opt.value = tool.id;
            opt.textContent = tool.displayName;
            selectType.appendChild(opt);
        });
    }

    function renderMappings(mappings) {
        multiSelectMapping.innerHTML = '';
        mappings.forEach(m => {
            const opt = document.createElement('vscode-option');
            opt.value = m.name;
            opt.textContent = m.name;
            opt.selected = true;
            multiSelectMapping.appendChild(opt);
        });
    }

    /**
     * Renders the list of instructions cards.
     * Uses event delegation for the tool selectors.
     */
    function renderInstructions(instructions, selectedState, availableTools) {
        if (!instructionList) return;
        instructionList.innerHTML = '';

        if (instructions.length === 0) {
            instructionList.innerHTML = `
                <div class="empty-state">
                    <h3>No Instructions Found</h3>
                    <p>Initialize a new instruction to get started.</p>
                </div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        instructions.forEach(inst => {
            const isActive = selectedState && inst.id === selectedState.id;
            const card = document.createElement('div');
            card.className = `instruction-card ${isActive ? 'active' : ''}`;

            // Safe Text Content
            const name = inst.name || 'Unnamed';
            const desc = inst.description || 'No description provided';

            const toolSelectorId = `tool-select-${inst.id}`;
            const linkedToolId = isActive ? selectedState.toolId : null;

            card.innerHTML = `
                <div class="card-header">
                    <div class="card-title">
                        <span class="codicon codicon-chevron-right"></span>
                        <span class="codicon codicon-beaker"></span>
                        <span class="inst-name"></span>
                    </div>
                    ${isActive
                    ? '<span class="badge linked">Active</span>'
                    : '<span class="badge">Inactive</span>'}
                </div>
                <div class="card-desc"></div>
                <div class="card-actions">
                    <vscode-single-select id="${toolSelectorId}" class="tool-selector" style="min-width: 150px;">
                        <vscode-option value="unlinked" ${!isActive ? 'selected' : ''}>None</vscode-option>
                    </vscode-single-select>
                </div>
            `;

            // inject text content safely
            card.querySelector('.inst-name').textContent = name;
            card.querySelector('.card-desc').textContent = desc;

            // Expand/Collapse Logic
            const header = card.querySelector('.card-header');
            const toggleExpand = () => card.classList.toggle('expanded');

            header.addEventListener('click', (e) => {
                // Ignore clicks on the badge
                if (e.target.closest('.badge')) return;
                toggleExpand();
            });

            // Also allow clicking the description to expand
            const descEl = card.querySelector('.card-desc');
            descEl.addEventListener('click', toggleExpand);

            // Populate the dropdown
            const select = card.querySelector('.tool-selector');
            availableTools.forEach(tool => {
                const opt = document.createElement('vscode-option');
                opt.value = tool.id;
                opt.textContent = tool.displayName;
                if (linkedToolId === tool.id) opt.selected = true;
                select.appendChild(opt);
            });

            select.addEventListener('change', (e) => {
                const val = e.target.value;
                handleToolChange(inst.id, val);
            });

            fragment.appendChild(card);
        });

        instructionList.appendChild(fragment);
    }

    function handleToolChange(instructionId, toolId) {
        if (toolId === 'unlinked') {
            vscode.postMessage({ type: 'unlink', id: instructionId });
        } else {
            vscode.postMessage({
                type: 'apply',
                id: instructionId,
                toolId: toolId
            });
        }
    }

    function resetCreateForm() {
        inputName.value = '';
        inputDesc.value = '';
        if (nameError) nameError.style.display = 'none';
        if (createErrorBanner) createErrorBanner.style.display = 'none';
        selectType.value = '';
        mappingContainer.classList.add('hidden');
        multiSelectMapping.innerHTML = '';
        btnSave.disabled = true;
    }
}());