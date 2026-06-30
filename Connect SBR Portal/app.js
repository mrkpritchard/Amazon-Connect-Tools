// ============================================================================
// CONFIGURATION - Update these values for your environment
// ============================================================================

// Cognito Configuration
const COGNITO_CONFIG = {
    UserPoolId: 'YOUR_USER_POOL_ID',           // e.g., us-east-1_XXXXXXXXX
    ClientId: 'YOUR_CLIENT_ID',                 // e.g., 26-character alphanumeric
    Region: 'us-east-1',
    RequiredGroup: 'SBR-Admin'                  // Cognito group required for admin access
};

// Region Configuration - Update with your API Gateway URLs and Connect Instance IDs
const REGION_CONFIG = {
    'us-east-1': {
        name: 'US (N. Virginia)',
        apiBaseUrl: 'YOUR_US_API_GATEWAY_URL',   // e.g., https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/api
        connectInstanceId: 'YOUR_US_INSTANCE_ID'  // e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    },
    'eu-central-1': {
        name: 'EU (Frankfurt)',
        apiBaseUrl: 'YOUR_EU_API_GATEWAY_URL',   // e.g., https://xxxxxxxxxx.execute-api.eu-central-1.amazonaws.com/prod/api
        connectInstanceId: 'YOUR_EU_INSTANCE_ID'  // e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    }
};

// ============================================================================
// END CONFIGURATION
// ============================================================================

// Initialize Cognito User Pool
const poolData = {
    UserPoolId: COGNITO_CONFIG.UserPoolId,
    ClientId: COGNITO_CONFIG.ClientId
};
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

// Configuration
let selectedRegion = localStorage.getItem('sbr_region') || 'us-east-1';
let API_BASE_URL = REGION_CONFIG[selectedRegion].apiBaseUrl;

// Enable mock data for testing (set to false when backend is ready)
const USE_MOCK_DATA = false;

// State management
let users = [];
let currentUser = null;
let pendingProficiencyChanges = [];
let originalProficienciesSnapshot = [];
let cognitoUser = null;
let authToken = null;
let availableProficiencies = [];
let currentProficiencyFilter = null;

// User permissions and groups
let userGroups = [];
let userIsAdmin = false;
let groupPermissions = [];
let editingGroupName = null;
let userPermissions = [];
let editingUserEmail = null;

// DOM Elements
const mainApp = document.getElementById('mainApp');
const loggedInUser = document.getElementById('loggedInUser');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const refreshBtn = document.getElementById('refreshBtn');
const usersTableBody = document.getElementById('usersTableBody');
const loadingIndicator = document.getElementById('loadingIndicator');
const errorMessage = document.getElementById('errorMessage');
const editModal = document.getElementById('editModal');
const closeModal = document.querySelector('.close');
const modalUserName = document.getElementById('modalUserName');
const currentProficiencies = document.getElementById('proficienciesContainer');
const addProficiencyBtn = document.getElementById('addProficiencyBtn');
const saveChangesBtn = document.getElementById('saveChangesBtn');
const cancelBtn = document.getElementById('cancelBtn');
const addProficiencyModal = document.getElementById('addProficiencyModal');
const closeAddModal = document.getElementById('closeAddModal');
const proficiencySelect = document.getElementById('proficiencySelect');
const proficiencyLevelSelect = document.getElementById('proficiencyLevelSelect');
const confirmAddBtn = document.getElementById('confirmAddBtn');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const regionSelect = document.getElementById('regionSelect');
const proficiencyFilter1 = document.getElementById('proficiencyFilter1');
const levelFilter1 = document.getElementById('levelFilter1');
const proficiencyFilter2 = document.getElementById('proficiencyFilter2');
const levelFilter2 = document.getElementById('levelFilter2');
const proficiencyFilter3 = document.getElementById('proficiencyFilter3');
const levelFilter3 = document.getElementById('levelFilter3');
const searchProficiencyBtn = document.getElementById('searchProficiencyBtn');
const clearProficiencyBtn = document.getElementById('clearProficiencyBtn');
const proficiencyResults = document.getElementById('proficiencyResults');
const proficiencyResultsCount = document.getElementById('proficiencyResultsCount');
const proficiencyResultsDetails = document.getElementById('proficiencyResultsDetails');
const proficiencySearchTableBody = document.getElementById('proficiencySearchTableBody');
const downloadUsersBtn = document.getElementById('downloadUsersBtn');
const downloadProficiencySearchBtn = document.getElementById('downloadProficiencySearchBtn');
const auditUserSearch = document.getElementById('auditUserSearch');
const auditDateFrom = document.getElementById('auditDateFrom');
const auditDateTo = document.getElementById('auditDateTo');
const searchAuditBtn = document.getElementById('searchAuditBtn');
const clearAuditBtn = document.getElementById('clearAuditBtn');
const refreshAuditBtn = document.getElementById('refreshAuditBtn');
const downloadAuditBtn = document.getElementById('downloadAuditBtn');
const auditLogTableBody = document.getElementById('auditLogTableBody');
const auditLogCount = document.getElementById('auditLogCount');

// State management for audit log
let auditLogs = [];
let filteredAuditLogs = [];

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    // Set region select to saved value
    regionSelect.value = selectedRegion;
    
    checkAuthStatus();
    setupEventListeners();
});

// Check if user is already authenticated
function checkAuthStatus() {
    console.log('Checking authentication status...');
    
    // Check for tokens from portal (stored in localStorage)
    const idToken = localStorage.getItem('idToken');
    const userEmail = localStorage.getItem('userEmail');
    const storedGroups = localStorage.getItem('userGroups');
    
    if (idToken) {
        try {
            // Decode JWT to check expiration
            const payload = JSON.parse(atob(idToken.split('.')[1]));
            const now = Math.floor(Date.now() / 1000);
            
            if (payload.exp && payload.exp > now) {
                // Token is valid
                authToken = idToken;
                
                // Check if user is in SBR-Admin group
                const groups = storedGroups ? JSON.parse(storedGroups) : [];
                const hasAdminAccess = groups.includes(COGNITO_CONFIG.RequiredGroup);
                
                // Store admin status
                window.isSBRAdmin = hasAdminAccess;
                
                // Display user info
                const email = userEmail || payload.email || payload.username || 'Unknown User';
                loggedInUser.textContent = `Logged in as: ${email}`;
                
                loadUsers();
                loadAvailableProficiencies();
                fetchUserGroups();
                return;
            } else {
                showError('Session expired. Please log in again.');
                return;
            }
        } catch (e) {
            console.error('Error parsing token:', e);
            showError('Invalid authentication token. Please log in again.');
            return;
        }
    }
    
    showError('Authentication required. Please log in first.');
}

// Event Listeners
function setupEventListeners() {
    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
    
    refreshBtn.addEventListener('click', loadUsers);
    downloadUsersBtn.addEventListener('click', downloadUsersToCSV);
    downloadProficiencySearchBtn.addEventListener('click', downloadProficiencySearchToCSV);
    closeModal.addEventListener('click', closeEditModal);
    cancelBtn.addEventListener('click', closeEditModal);
    addProficiencyBtn.addEventListener('click', openAddProficiencyModal);
    saveChangesBtn.addEventListener('click', saveAllChanges);
    
    // Proficiency filter handlers
    searchProficiencyBtn.addEventListener('click', handleProficiencySearch);
    clearProficiencyBtn.addEventListener('click', clearProficiencyFilter);
    proficiencyFilter1.addEventListener('change', () => {
        if (!proficiencyFilter1.value) {
            clearProficiencyFilter();
        }
    });
    
    // Add proficiency modal handlers
    closeAddModal.addEventListener('click', closeAddProficiencyModal);
    cancelAddBtn.addEventListener('click', closeAddProficiencyModal);
    confirmAddBtn.addEventListener('click', confirmAddProficiency);
    
    // Audit log handlers
    searchAuditBtn.addEventListener('click', filterAuditLogs);
    clearAuditBtn.addEventListener('click', clearAuditFilters);
    refreshAuditBtn.addEventListener('click', loadAuditLogs);
    downloadAuditBtn.addEventListener('click', downloadAuditLogToCSV);
    
    // Configuration tab handlers
    const addGroupPermissionBtn = document.getElementById('addGroupPermissionBtn');
    const cancelGroupPermissionBtn = document.getElementById('cancelGroupPermissionBtn');
    const saveGroupPermissionBtn = document.getElementById('saveGroupPermissionBtn');
    const groupPermissionModal = document.getElementById('groupPermissionModal');
    
    if (addGroupPermissionBtn) {
        addGroupPermissionBtn.addEventListener('click', () => openGroupPermissionModal());
    }
    if (cancelGroupPermissionBtn) {
        cancelGroupPermissionBtn.addEventListener('click', closeGroupPermissionModal);
    }
    if (saveGroupPermissionBtn) {
        saveGroupPermissionBtn.addEventListener('click', saveGroupPermission);
    }
    
    // User permission modal handlers
    const addUserPermissionBtn = document.getElementById('addUserPermissionBtn');
    const userPermissionSubmit = document.getElementById('userPermissionSubmit');
    const userPermissionCancel = document.getElementById('userPermissionCancel');
    const userPermissionModal = document.getElementById('userPermissionModal');
    if (addUserPermissionBtn) {
        addUserPermissionBtn.addEventListener('click', () => openUserPermissionModal());
    }
    if (userPermissionSubmit) {
        userPermissionSubmit.addEventListener('click', saveUserPermission);
    }
    if (userPermissionCancel) {
        userPermissionCancel.addEventListener('click', closeUserPermissionModal);
    }

    // Close modal when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === editModal) closeEditModal();
        if (e.target === addProficiencyModal) closeAddProficiencyModal();
        if (e.target === groupPermissionModal) closeGroupPermissionModal();
        if (e.target === userPermissionModal) closeUserPermissionModal();
    });
}

// Tab Switching
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1)).classList.add('active');
    document.getElementById('tabContent-' + tabName).classList.add('active');
    
    if (tabName === 'userManagement' && currentProficiencyFilter) {
        clearProficiencyFilter();
    }
    
    if (tabName === 'proficiencySearch' && availableProficiencies.length === 0) {
        loadAvailableProficiencies();
    }
    
    if (tabName === 'auditLog' && auditLogs.length === 0) {
        loadAuditLogs();
    }
    
    if (tabName === 'securityProfiles' && userIsAdmin) {
        if (groupPermissions.length === 0) loadGroupPermissions();
        if (userPermissions.length === 0) loadUserPermissions();
    }
}

// Load users from the API
async function loadUsers() {
    if (!authToken) {
        showError('Authentication required. Please refresh the page or log in again.');
        return;
    }
    
    showLoading(true);
    hideError();
    
    try {
        if (USE_MOCK_DATA) {
            console.log('Using mock data (backend not configured)');
            await new Promise(resolve => setTimeout(resolve, 500));
            
            users = [
                {
                    id: 'user-001',
                    name: 'John Smith',
                    email: 'john.smith@example.com',
                    username: 'jsmith',
                    proficiencies: [
                        { name: 'Technical Support', level: 4 },
                        { name: 'Sales', level: 3 },
                        { name: 'Billing', level: 2 }
                    ]
                },
                {
                    id: 'user-002',
                    name: 'Sarah Johnson',
                    email: 'sarah.johnson@example.com',
                    username: 'sjohnson',
                    proficiencies: [
                        { name: 'Customer Service', level: 5 },
                        { name: 'Technical Support', level: 3 }
                    ]
                },
                {
                    id: 'user-003',
                    name: 'Mike Davis',
                    email: 'mike.davis@example.com',
                    username: 'mdavis',
                    proficiencies: [
                        { name: 'Sales', level: 5 },
                        { name: 'Account Management', level: 4 }
                    ]
                },
                {
                    id: 'user-004',
                    name: 'Emily Chen',
                    email: 'emily.chen@example.com',
                    username: 'echen',
                    proficiencies: []
                }
            ];
            
            displayUsers(users);
            showSuccess('Mock data loaded. Configure backend API to see real Amazon Connect users.');
            return;
        }
        
        // Retry logic for API calls
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await fetch(`${API_BASE_URL}/users`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
                
                if (response.ok) {
                    users = await response.json();
                    displayUsers(users);
                    return;
                }
                
                lastError = new Error(`Failed to fetch users: ${response.statusText}`);
                
                if (response.status === 503 && attempt < 3) {
                    console.log(`Attempt ${attempt} failed with 503, retrying in ${attempt * 2} seconds...`);
                    showError(`Loading users... (attempt ${attempt}/3, retrying...)`);
                    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
                    continue;
                }
                
                throw lastError;
            } catch (fetchError) {
                lastError = fetchError;
                if (attempt < 3) {
                    console.log(`Attempt ${attempt} failed, retrying in ${attempt * 2} seconds...`);
                    showError(`Loading users... (attempt ${attempt}/3, retrying...)`);
                    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
                }
            }
        }
        
        throw lastError;
        
    } catch (error) {
        showError(`Error loading users: ${error.message}. Click "Refresh Users" to try again.`);
        console.error('Error loading users:', error);
        
        users = [];
        displayUsers(users);
    } finally {
        showLoading(false);
    }
}

// Load available proficiencies from Amazon Connect
async function loadAvailableProficiencies() {
    if (!authToken) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/proficiencies`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load proficiencies: ${response.statusText}`);
        }
        
        const data = await response.json();
        availableProficiencies = Array.isArray(data) ? data : (data.proficiencies || []);
        
        if (proficiencySelect && availableProficiencies.length > 0) {
            proficiencySelect.innerHTML = '<option value="">Select a proficiency...</option>' +
                availableProficiencies.map(prof => 
                    `<option value="${prof.name}|${prof.value}">${prof.displayName}</option>`
                ).join('');
        }
        
        if (proficiencyFilter1 && availableProficiencies.length > 0) {
            const options = '<option value="">Select a proficiency...</option>' +
                availableProficiencies.map(prof => 
                    `<option value="${prof.name}|${prof.value}">${prof.displayName}</option>`
                ).join('');
            proficiencyFilter1.innerHTML = options;
            proficiencyFilter2.innerHTML = options;
            proficiencyFilter3.innerHTML = options;
        }
    } catch (error) {
        console.error('Error loading proficiencies:', error);
        if (proficiencySelect) {
            proficiencySelect.innerHTML = '<option value="">Error loading proficiencies</option>';
        }
    }
}

// Handle proficiency search
function handleProficiencySearch() {
    const filters = [];
    
    if (proficiencyFilter1.value) {
        const [name, value] = proficiencyFilter1.value.split('|');
        filters.push({
            name,
            value,
            level: levelFilter1.value,
            displayName: availableProficiencies.find(p => p.name === name && p.value === value)?.displayName || `${name} - ${value}`
        });
    }
    
    if (proficiencyFilter2.value) {
        const [name, value] = proficiencyFilter2.value.split('|');
        filters.push({
            name,
            value,
            level: levelFilter2.value,
            displayName: availableProficiencies.find(p => p.name === name && p.value === value)?.displayName || `${name} - ${value}`
        });
    }
    
    if (proficiencyFilter3.value) {
        const [name, value] = proficiencyFilter3.value.split('|');
        filters.push({
            name,
            value,
            level: levelFilter3.value,
            displayName: availableProficiencies.find(p => p.name === name && p.value === value)?.displayName || `${name} - ${value}`
        });
    }
    
    if (filters.length === 0) {
        showError('Please select at least one proficiency to search for');
        return;
    }
    
    const filteredUsers = users.filter(user => {
        return filters.every(filter => {
            return user.proficiencies.some(prof => {
                const matchesProficiency = prof.name === filter.name && prof.value === filter.value;
                const matchesLevel = !filter.level || prof.level == filter.level;
                return matchesProficiency && matchesLevel;
            });
        });
    });
    
    currentProficiencyFilter = filters;
    
    displayUsers(filteredUsers, proficiencySearchTableBody);
    
    const filterDescriptions = filters.map(f => {
        const levelText = f.level ? ` (Level ${f.level})` : '';
        return `${f.displayName}${levelText}`;
    });
    
    proficiencyResultsCount.textContent = `Found ${filteredUsers.length} user${filteredUsers.length !== 1 ? 's' : ''} with ${filters.length > 1 ? 'all of' : ''} the following:`;
    proficiencyResultsDetails.innerHTML = filterDescriptions.map(desc => `<div style="margin-top: 4px;">• ${desc}</div>`).join('');
    proficiencyResults.style.display = 'block';
    
    searchInput.value = '';
    hideError();
}

// Clear proficiency filter
function clearProficiencyFilter() {
    currentProficiencyFilter = null;
    proficiencyFilter1.value = '';
    levelFilter1.value = '';
    proficiencyFilter2.value = '';
    levelFilter2.value = '';
    proficiencyFilter3.value = '';
    levelFilter3.value = '';
    proficiencyResults.style.display = 'none';
    displayUsers(users);
}

// Helper function to get proficiency display name
function getProficiencyDisplayName(prof) {
    if (prof.value && prof.value !== prof.name) {
        let displayValue = prof.value;
        if (prof.name === 'connect:Language' && prof.value.startsWith('connect:')) {
            displayValue = prof.value.replace('connect:', '');
        }
        return `${prof.name} - ${displayValue}`;
    }
    return prof.name;
}

// Display users in the table
function displayUsers(usersToDisplay, targetTable = usersTableBody) {
    targetTable.innerHTML = '';
    
    if (!usersToDisplay || usersToDisplay.length === 0) {
        targetTable.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; padding: 40px; color: var(--muted);">
                    No users found. Make sure your Amazon Connect instance is configured correctly.
                </td>
            </tr>
        `;
        return;
    }
    
    usersToDisplay.forEach(user => {
        const row = createUserRow(user);
        targetTable.appendChild(row);
    });
}

// Create a table row for a user
function createUserRow(user) {
    const row = document.createElement('tr');
    
    const proficienciesHTML = user.proficiencies && user.proficiencies.length > 0
        ? user.proficiencies.map(prof => 
            `<span class="proficiency-tag level-${prof.level}">${getProficiencyDisplayName(prof)} (L${prof.level})</span>`
          ).join('')
        : '<span style="color: #999; font-style: italic;">No proficiencies</span>';
    
    row.innerHTML = `
        <td>${user.name || 'N/A'}</td>
        <td>${user.routingProfile || '<span style="color: var(--muted); font-style: italic;">N/A</span>'}</td>
        <td>${proficienciesHTML}</td>
        <td style="text-align: right;">
            <button class="btn primary" onclick="openEditModal('${user.id}')">Edit</button>
        </td>
    `;
    
    return row;
}

// Handle search functionality
function handleSearch() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    if (!searchTerm) {
        displayUsers(users);
        return;
    }
    
    const filteredUsers = users.filter(user => 
        (user.name && user.name.toLowerCase().includes(searchTerm)) ||
        (user.email && user.email.toLowerCase().includes(searchTerm)) ||
        (user.username && user.username.toLowerCase().includes(searchTerm))
    );
    
    displayUsers(filteredUsers);
}

// Open the edit modal for a specific user
async function openEditModal(userId) {
    const user = users.find(u => u.id === userId);
    
    if (!user) {
        showError('User not found');
        return;
    }
    
    currentUser = user;
    pendingProficiencyChanges = [...(user.proficiencies || [])];
    originalProficienciesSnapshot = JSON.parse(JSON.stringify(user.proficiencies || []));
    
    modalUserName.textContent = user.name || 'N/A';
    
    displayCurrentProficiencies();
    
    editModal.style.display = 'block';
}

// Display current proficiencies in the modal
function displayCurrentProficiencies() {
    currentProficiencies.innerHTML = '';
    
    if (pendingProficiencyChanges.length === 0) {
        currentProficiencies.innerHTML = '<p class="no-proficiencies">No proficiencies assigned</p>';
        return;
    }
    
    pendingProficiencyChanges.forEach((prof, index) => {
        const profItem = document.createElement('div');
        profItem.className = 'proficiency-item';
        profItem.innerHTML = `
            <div class="proficiency-info">
                <div class="proficiency-name">${getProficiencyDisplayName(prof)}</div>
                <select class="proficiency-level-select" onchange="updateProficiencyLevel(${index}, this.value)">
                    <option value="1" ${prof.level === 1 ? 'selected' : ''}>Level 1</option>
                    <option value="2" ${prof.level === 2 ? 'selected' : ''}>Level 2</option>
                    <option value="3" ${prof.level === 3 ? 'selected' : ''}>Level 3</option>
                    <option value="4" ${prof.level === 4 ? 'selected' : ''}>Level 4</option>
                    <option value="5" ${prof.level === 5 ? 'selected' : ''}>Level 5</option>
                </select>
            </div>
            <button class="btn btn-danger" onclick="removeProficiency(${index})">Remove</button>
        `;
        currentProficiencies.appendChild(profItem);
    });
}

// Open add proficiency modal
async function openAddProficiencyModal() {
    if (availableProficiencies.length === 0) {
        proficiencySelect.innerHTML = '<option value="">Loading proficiencies...</option>';
        await loadAvailableProficiencies();
    }
    
    proficiencySelect.selectedIndex = 0;
    proficiencyLevelSelect.value = '3';
    
    addProficiencyModal.style.display = 'block';
}

// Close add proficiency modal
function closeAddProficiencyModal() {
    addProficiencyModal.style.display = 'none';
}

// Confirm adding proficiency
function confirmAddProficiency() {
    const selectedValue = proficiencySelect.value;
    const level = parseInt(proficiencyLevelSelect.value);
    
    if (!selectedValue) {
        alert('Please select a proficiency');
        return;
    }
    
    const [name, value] = selectedValue.split('|');
    
    const exists = pendingProficiencyChanges.find(p => 
        p.name === name && p.value === value
    );
    
    if (exists) {
        alert('This proficiency is already assigned to this user');
        return;
    }
    
    pendingProficiencyChanges.push({ name, value, level });
    displayCurrentProficiencies();
    closeAddProficiencyModal();
}

// Update proficiency level
function updateProficiencyLevel(index, newLevel) {
    pendingProficiencyChanges[index].level = parseInt(newLevel);
}

// Remove a proficiency
function removeProficiency(index) {
    pendingProficiencyChanges.splice(index, 1);
    displayCurrentProficiencies();
}

// Save all changes
async function saveAllChanges() {
    if (!currentUser || !authToken) return;
    
    showLoading(true);
    hideError();
    
    try {
        if (USE_MOCK_DATA) {
            await new Promise(resolve => setTimeout(resolve, 800));
            
            const userIndex = users.findIndex(u => u.id === currentUser.id);
            if (userIndex !== -1) {
                users[userIndex].proficiencies = [...pendingProficiencyChanges];
            }
            
            displayUsers(users);
            closeEditModal();
            showSuccess('Proficiencies updated successfully! (Mock mode - configure backend to save to Amazon Connect)');
            return;
        }
        
        const response = await fetch(`${API_BASE_URL}/users/${currentUser.id}/proficiencies`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                proficiencies: pendingProficiencyChanges
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to save changes: ${response.statusText}`);
        }
        
        const updatedUser = await response.json();
        
        const userIndex = users.findIndex(u => u.id === currentUser.id);
        if (userIndex !== -1) {
            users[userIndex] = updatedUser;
        }
        
        await logAuditEvent(currentUser, originalProficienciesSnapshot, pendingProficiencyChanges);
        
        displayUsers(users);
        closeEditModal();
        
        showSuccess('Proficiencies updated successfully!');
    } catch (error) {
        showError(`Error saving changes: ${error.message}`);
        console.error('Error saving changes:', error);
    } finally {
        showLoading(false);
    }
}

// Close the edit modal
function closeEditModal() {
    editModal.style.display = 'none';
    currentUser = null;
    pendingProficiencyChanges = [];
}

// Handle region change
function handleRegionChange() {
    selectedRegion = regionSelect.value;
    localStorage.setItem('sbr_region', selectedRegion);
    API_BASE_URL = REGION_CONFIG[selectedRegion].apiBaseUrl;
    
    users = [];
    availableProficiencies = [];
    currentUser = null;
    pendingProficiencyChanges = [];
    
    closeEditModal();
    closeAddProficiencyModal();
    
    loadUsers();
    loadAvailableProficiencies();
}

// Utility functions
function showLoading(show) {
    loadingIndicator.style.display = show ? 'block' : 'none';
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    
    setTimeout(() => {
        hideError();
    }, 5000);
}

function hideError() {
    errorMessage.style.display = 'none';
}

function showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #28a745;
        color: white;
        padding: 15px 25px;
        border-radius: 5px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 2000;
        animation: slideIn 0.3s;
    `;
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    
    setTimeout(() => {
        successDiv.remove();
    }, 3000);
}

// Download Users to CSV
function downloadUsersToCSV() {
    const tableRows = usersTableBody.querySelectorAll('tr');
    
    if (tableRows.length === 0 || (tableRows.length === 1 && tableRows[0].querySelector('td[colspan]'))) {
        showError('No users to download');
        return;
    }
    
    const searchTerm = searchInput.value.toLowerCase().trim();
    const usersToDownload = searchTerm ? 
        users.filter(user => 
            (user.name && user.name.toLowerCase().includes(searchTerm)) ||
            (user.email && user.email.toLowerCase().includes(searchTerm)) ||
            (user.username && user.username.toLowerCase().includes(searchTerm))
        ) : users;
    
    downloadCSV(usersToDownload, 'users');
}

// Download Proficiency Search Results to CSV
function downloadProficiencySearchToCSV() {
    if (!currentProficiencyFilter || currentProficiencyFilter.length === 0) {
        showError('Please perform a proficiency search first');
        return;
    }
    
    const tableRows = proficiencySearchTableBody.querySelectorAll('tr');
    
    if (tableRows.length === 0 || (tableRows.length === 1 && tableRows[0].querySelector('td[colspan]'))) {
        showError('No search results to download');
        return;
    }
    
    const filteredUsers = users.filter(user => {
        return currentProficiencyFilter.every(filter => {
            return user.proficiencies.some(prof => {
                const matchesProficiency = prof.name === filter.name && prof.value === filter.value;
                const matchesLevel = !filter.level || prof.level == filter.level;
                return matchesProficiency && matchesLevel;
            });
        });
    });
    
    const filterNames = currentProficiencyFilter.map(f => f.displayName).join('_');
    const filename = `proficiency_search_${filterNames.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_')}`;
    downloadCSV(filteredUsers, filename);
}

// Generic CSV download function
function downloadCSV(usersData, filenamePrefix) {
    const headers = ['Name', 'Proficiencies'];
    const csvRows = [headers.join(',')];
    
    usersData.forEach(user => {
        const name = `"${(user.name || 'N/A').replace(/"/g, '""')}"`;
        
        let proficienciesStr = '';
        if (user.proficiencies && user.proficiencies.length > 0) {
            const profList = user.proficiencies.map(prof => {
                const displayName = getProficiencyDisplayName(prof);
                return `${displayName} (L${prof.level})`;
            }).join('; ');
            proficienciesStr = `"${profList.replace(/"/g, '""')}"`;
        } else {
            proficienciesStr = '"No proficiencies"';
        }
        
        csvRows.push([name, proficienciesStr].join(','));
    });
    
    const csvContent = csvRows.join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const regionName = REGION_CONFIG[selectedRegion].name.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${filenamePrefix}_${regionName}_${timestamp}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showSuccess(`Downloaded ${usersData.length} user${usersData.length !== 1 ? 's' : ''} to ${filename}`);
}

// ===== AUDIT LOG FUNCTIONS =====

// Resolve the logged-in user's display name from JWT token
function resolveCurrentUserName() {
    try {
        const payload = JSON.parse(atob(authToken.split('.')[1]));
        const tokenName = payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ');
        if (tokenName) return tokenName;
        const email = payload.email || localStorage.getItem('userEmail') || '';
        if (email) {
            const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
            if (match && match.name) return match.name;
        }
        if (email) {
            const local = email.split('@')[0];
            return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
        return 'Unknown';
    } catch (e) {
        return 'Unknown';
    }
}

// Log an audit event when proficiencies are changed
async function logAuditEvent(user, oldProficiencies, newProficiencies) {
    try {
        const modifiedByName = resolveCurrentUserName();
        
        const changes = calculateProficiencyChanges(oldProficiencies, newProficiencies);
        
        const auditEvent = {
            timestamp: new Date().toISOString(),
            userId: user.id,
            userName: user.name,
            modifiedBy: modifiedByName,
            changes: changes,
            region: selectedRegion
        };
        
        const response = await fetch(`${API_BASE_URL}/audit`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(auditEvent)
        });
        
        if (!response.ok) {
            console.error('Failed to log audit event:', response.statusText);
        } else {
            const auditTab = document.getElementById('tabContent-auditLog');
            if (auditTab && auditTab.classList.contains('active')) {
                loadAuditLogs();
            }
        }
    } catch (error) {
        console.error('Error logging audit event:', error);
    }
}

// Calculate what changed between old and new proficiencies
function calculateProficiencyChanges(oldProfs, newProfs) {
    const changes = [];
    
    const oldProfMap = new Map();
    oldProfs.forEach(prof => {
        const key = `${prof.name}|${prof.value}`;
        oldProfMap.set(key, prof);
    });
    
    const newProfMap = new Map();
    newProfs.forEach(prof => {
        const key = `${prof.name}|${prof.value}`;
        newProfMap.set(key, prof);
    });
    
    // Find removed proficiencies
    oldProfMap.forEach((oldProf, key) => {
        if (!newProfMap.has(key)) {
            changes.push({
                action: 'Removed',
                proficiency: getProficiencyDisplayName(oldProf),
                level: oldProf.level
            });
        }
    });
    
    // Find added and updated proficiencies
    newProfMap.forEach((newProf, key) => {
        const oldProf = oldProfMap.get(key);
        if (!oldProf) {
            changes.push({
                action: 'Added',
                proficiency: getProficiencyDisplayName(newProf),
                level: newProf.level
            });
        } else {
            const oldLevel = Number(oldProf.level);
            const newLevel = Number(newProf.level);
            if (oldLevel !== newLevel) {
                changes.push({
                    action: 'Updated',
                    proficiency: getProficiencyDisplayName(newProf),
                    oldLevel: oldLevel,
                    newLevel: newLevel
                });
            }
        }
    });
    
    return changes;
}

// Load audit logs from backend
async function loadAuditLogs() {
    if (!authToken) {
        showError('Authentication required');
        return;
    }
    
    auditLogTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px; color: var(--muted);">Loading audit log...</td></tr>';
    
    try {
        const response = await fetch(`${API_BASE_URL}/audit`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load audit log: ${response.statusText}`);
        }
        
        auditLogs = await response.json();
        filteredAuditLogs = auditLogs;
        displayAuditLogs(auditLogs);
    } catch (error) {
        console.error('Error loading audit log:', error);
        auditLogTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 40px; color: var(--error);">Error loading audit log: ${error.message}</td></tr>`;
        auditLogCount.textContent = 'Error loading audit log';
    }
}

// Display audit logs in the table
function displayAuditLogs(logs) {
    auditLogTableBody.innerHTML = '';
    
    if (!logs || logs.length === 0) {
        auditLogTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px; color: var(--muted);">No audit logs found</td></tr>';
        auditLogCount.textContent = 'No audit logs found';
        return;
    }
    
    const sortedLogs = [...logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    sortedLogs.forEach(log => {
        const row = document.createElement('tr');
        
        const date = new Date(log.timestamp);
        const formattedDate = date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        let changesHTML = '';
        if (log.changes && log.changes.length > 0) {
            changesHTML = log.changes.map(change => {
                if (change.action === 'Added') {
                    return `<div style="color: #10b981; font-weight: 500; margin-bottom: 4px;">✓ Added: ${change.proficiency} (L${change.level})</div>`;
                } else if (change.action === 'Removed') {
                    return `<div style="color: #ef4444; font-weight: 500; margin-bottom: 4px;">✗ Removed: ${change.proficiency} (L${change.level})</div>`;
                } else if (change.action === 'Updated') {
                    return `<div style="color: #f59e0b; font-weight: 500; margin-bottom: 4px;">↻ Updated: ${change.proficiency} (L${change.oldLevel} → L${change.newLevel})</div>`;
                }
            }).join('');
        } else {
            changesHTML = '<span style="color: var(--muted); font-style: italic;">No changes recorded</span>';
        }
        
        row.innerHTML = `
            <td style="font-family: monospace; font-size: 13px;">${formattedDate}</td>
            <td>${log.userName || 'Unknown User'}</td>
            <td>${log.modifiedBy || 'Unknown'}</td>
            <td>${changesHTML}</td>
        `;
        
        auditLogTableBody.appendChild(row);
    });
    
    auditLogCount.textContent = `Showing ${logs.length} audit log entr${logs.length !== 1 ? 'ies' : 'y'}`;
}

// Filter audit logs
function filterAuditLogs() {
    const searchTerm = auditUserSearch.value.toLowerCase().trim();
    const dateFrom = auditDateFrom.value ? new Date(auditDateFrom.value) : null;
    const dateTo = auditDateTo.value ? new Date(auditDateTo.value + 'T23:59:59') : null;
    
    filteredAuditLogs = auditLogs.filter(log => {
        if (searchTerm) {
            const matchesUser = log.userName && log.userName.toLowerCase().includes(searchTerm);
            const matchesModifiedBy = log.modifiedBy && log.modifiedBy.toLowerCase().includes(searchTerm);
            if (!matchesUser && !matchesModifiedBy) return false;
        }
        
        if (dateFrom || dateTo) {
            const logDate = new Date(log.timestamp);
            if (dateFrom && logDate < dateFrom) return false;
            if (dateTo && logDate > dateTo) return false;
        }
        
        return true;
    });
    
    displayAuditLogs(filteredAuditLogs);
}

// Clear audit filters
function clearAuditFilters() {
    auditUserSearch.value = '';
    auditDateFrom.value = '';
    auditDateTo.value = '';
    filteredAuditLogs = auditLogs;
    displayAuditLogs(auditLogs);
}

// Download audit log to CSV
function downloadAuditLogToCSV() {
    if (!filteredAuditLogs || filteredAuditLogs.length === 0) {
        showError('No audit logs to download');
        return;
    }
    
    const headers = ['Timestamp', 'User Modified', 'Modified By', 'Action', 'Proficiency', 'Details'];
    const csvRows = [headers.join(',')];
    
    filteredAuditLogs.forEach(log => {
        const timestamp = `"${new Date(log.timestamp).toLocaleString()}"`;
        const userName = `"${(log.userName || 'Unknown').replace(/"/g, '""')}"`;
        const modifiedBy = `"${(log.modifiedBy || 'Unknown').replace(/"/g, '""')}"`;
        
        if (log.changes && log.changes.length > 0) {
            log.changes.forEach(change => {
                const action = `"${change.action}"`;
                const proficiency = `"${change.proficiency.replace(/"/g, '""')}"`;
                let details = '';
                if (change.action === 'Updated') {
                    details = `"Level ${change.oldLevel} to ${change.newLevel}"`;
                } else {
                    details = `"Level ${change.level}"`;
                }
                csvRows.push([timestamp, userName, modifiedBy, action, proficiency, details].join(','));
            });
        } else {
            csvRows.push([timestamp, userName, modifiedBy, '"No changes"', '""', '""'].join(','));
        }
    });
    
    const csvContent = csvRows.join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const regionName = REGION_CONFIG[selectedRegion].name.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `audit_log_${regionName}_${timestamp}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showSuccess(`Downloaded ${filteredAuditLogs.length} audit log entr${filteredAuditLogs.length !== 1 ? 'ies' : 'y'} to ${filename}`);
}

// ============================================================================
// Configuration Tab Functions
// ============================================================================

async function fetchUserGroups() {
    if (!authToken) return;
    
    try {
        const payload = JSON.parse(atob(authToken.split('.')[1]));
        const groups = payload['cognito:groups'] || [];
        
        userGroups = groups;
        userIsAdmin = groups.includes('SBR-Admin') || groups.includes('Callback-Admin');
        
        const configTab = document.getElementById('tabSecurityProfiles');
        if (configTab) {
            configTab.style.display = userIsAdmin ? 'inline-block' : 'none';
        }
        
    } catch (error) {
        console.error('Error fetching user groups:', error);
    }
}

async function loadGroupPermissions() {
    if (!authToken || !userIsAdmin) return;
    
    const container = document.getElementById('groupPermissionsTableContainer');
    if (!container) return;
    
    try {
        container.innerHTML = '<div style="color: var(--muted);">Loading permissions...</div>';
        
        const response = await fetch(`${API_BASE_URL}/groups?region=${selectedRegion}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        
        const data = await response.json();
        groupPermissions = data.groups || [];
        
        renderGroupPermissionsTable(groupPermissions);
        
    } catch (error) {
        console.error('Error loading group permissions:', error);
        container.innerHTML = `<div style="color: var(--error);">Error loading permissions: ${error.message}</div>`;
    }
}

function renderGroupPermissionsTable(groups) {
    const container = document.getElementById('groupPermissionsTableContainer');
    if (!container) return;
    
    if (!groups || groups.length === 0) {
        container.innerHTML = '<div style="color: var(--muted);">No group permissions configured yet.</div>';
        return;
    }
    
    let html = `
        <div class="table-wrapper" style="margin-top: 16px;">
            <table>
                <thead>
                    <tr>
                        <th>Group Name</th>
                        <th>Allowed Proficiencies</th>
                        <th>Can Modify Users</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
    `;
    
    groups.forEach(group => {
        const proficiencies = group.AllowedProficiencies && group.AllowedProficiencies.length > 0
            ? group.AllowedProficiencies.join(', ')
            : 'All proficiencies';
        const canModify = group.CanModifyUsers ? 'Yes' : 'No';
        
        html += `
            <tr>
                <td>${escapeHtml(group.GroupName)}</td>
                <td>${escapeHtml(proficiencies)}</td>
                <td>${canModify}</td>
                <td>
                    <button class="btn secondary" onclick="editGroupPermission('${escapeHtml(group.GroupName)}')">Edit</button>
                    <button class="btn" onclick="deleteGroupPermission('${escapeHtml(group.GroupName)}')">Delete</button>
                </td>
            </tr>
        `;
    });
    
    html += `
                </tbody>
            </table>
        </div>
    `;
    
    container.innerHTML = html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function openGroupPermissionModal(groupName = null) {
    editingGroupName = groupName;
    
    const modal = document.getElementById('groupPermissionModal');
    const title = document.getElementById('groupPermissionModalTitle');
    const groupNameInput = document.getElementById('groupNameInput');
    const allowedProficienciesInput = document.getElementById('allowedProficienciesInput');
    const canModifyCheckbox = document.getElementById('canModifyUsersCheckbox');
    
    if (!modal || !title || !groupNameInput || !allowedProficienciesInput || !canModifyCheckbox) {
        console.error('Group permission modal elements not found');
        return;
    }
    
    if (groupName) {
        title.textContent = 'Edit Group';
        const group = groupPermissions.find(g => g.GroupName === groupName);
        
        if (group) {
            groupNameInput.value = group.GroupName;
            groupNameInput.disabled = true;
            allowedProficienciesInput.value = group.AllowedProficiencies ? group.AllowedProficiencies.join(', ') : '';
            canModifyCheckbox.checked = group.CanModifyUsers || false;
        }
    } else {
        title.textContent = 'Add Group';
        groupNameInput.value = '';
        groupNameInput.disabled = false;
        allowedProficienciesInput.value = '';
        canModifyCheckbox.checked = false;
    }
    
    modal.style.display = 'block';
}

function closeGroupPermissionModal() {
    const modal = document.getElementById('groupPermissionModal');
    if (modal) {
        modal.style.display = 'none';
    }
    editingGroupName = null;
}

async function saveGroupPermission() {
    const groupNameInput = document.getElementById('groupNameInput');
    const allowedProficienciesInput = document.getElementById('allowedProficienciesInput');
    const canModifyCheckbox = document.getElementById('canModifyUsersCheckbox');
    
    if (!groupNameInput || !allowedProficienciesInput || !canModifyCheckbox) {
        console.error('Group permission modal inputs not found');
        return;
    }
    
    const groupName = groupNameInput.value.trim();
    if (!groupName) {
        showError('Please enter a group name');
        return;
    }
    
    const proficienciesText = allowedProficienciesInput.value.trim();
    const allowedProficiencies = proficienciesText
        ? proficienciesText.split(',').map(p => p.trim()).filter(p => p.length > 0)
        : [];
    
    const canModifyUsers = canModifyCheckbox.checked;
    
    const groupData = {
        GroupName: groupName,
        AllowedProficiencies: allowedProficiencies,
        CanModifyUsers: canModifyUsers,
        Region: selectedRegion
    };
    
    try {
        const method = editingGroupName ? 'PUT' : 'POST';
        const url = editingGroupName 
            ? `${API_BASE_URL}/groups/${encodeURIComponent(editingGroupName)}`
            : `${API_BASE_URL}/groups`;
        
        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(groupData)
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error ${response.status}`);
        }
        
        showSuccess(editingGroupName ? 'Group permission updated successfully' : 'Group permission added successfully');
        closeGroupPermissionModal();
        loadGroupPermissions();
        
    } catch (error) {
        console.error('Error saving group permission:', error);
        showError(`Failed to save group permission: ${error.message}`);
    }
}

async function deleteGroupPermission(groupName) {
    if (!confirm(`Are you sure you want to delete the permission for "${groupName}"?`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/groups/${encodeURIComponent(groupName)}?region=${selectedRegion}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        
        showSuccess(`Group "${groupName}" deleted successfully`);
        loadGroupPermissions();
        
    } catch (error) {
        console.error('Error deleting group permission:', error);
        showError(`Failed to delete group: ${error.message}`);
    }
}

function editGroupPermission(groupName) {
    openGroupPermissionModal(groupName);
}
// ============================================================================
// User Permission Functions
// ============================================================================
async function loadUserPermissions() {
    if (!authToken || !userIsAdmin) return;
    const container = document.getElementById('userPermissionsTableContainer');
    if (!container) return;
    try {
        container.innerHTML = '<div style="color: var(--muted);">Loading permissions...</div>';
        const response = await fetch(`${API_BASE_URL}/config/users?region=${selectedRegion}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        const data = await response.json();
        userPermissions = data.users || [];
        renderUserPermissionsTable(userPermissions);
    } catch (error) {
        console.error('Error loading user permissions:', error);
        container.innerHTML = `<div style="color: var(--danger);">Error loading permissions: ${error.message}</div>`;
    }
}
function renderUserPermissionsTable(users) {
    const container = document.getElementById('userPermissionsTableContainer');
    if (!container) return;
    if (!users || users.length === 0) {
        container.innerHTML = '<div style="color: var(--muted);">No user permissions configured yet.</div>';
        return;
    }
    let html = `
        <div class="table-wrapper" style="margin-top: 16px;">
            <table>
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Allowed Regions</th>
                        <th>Allowed Proficiencies</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
    `;
    users.forEach(user => {
        const regions = user.AllowedRegions && user.AllowedRegions.length > 0
            ? user.AllowedRegions.join(', ')
            : 'All regions';
        const proficiencies = user.AllowedProficiencies && user.AllowedProficiencies.length > 0
            ? user.AllowedProficiencies.join(', ')
            : 'All proficiencies';
        html += `
            <tr>
                <td>${escapeHtml(user.Email)}</td>
                <td>${escapeHtml(regions)}</td>
                <td>${escapeHtml(proficiencies)}</td>
                <td>
                    <button class="btn secondary" onclick="editUserPermission('${escapeHtml(user.Email)}')">Edit</button>
                    <button class="btn danger" onclick="deleteUserPermission('${escapeHtml(user.Email)}')">Delete</button>
                </td>
            </tr>
        `;
    });
    html += `
                </tbody>
            </table>
        </div>
    `;
    container.innerHTML = html;
}
function openUserPermissionModal(email = null) {
    editingUserEmail = email;
    const modal = document.getElementById('userPermissionModal');
    const title = document.getElementById('userPermissionModalTitle');
    const emailInput = document.getElementById('userEmailInput');
    const allowedProficienciesInput = document.getElementById('allowedProficienciesUserInput');
    const regionUSEast = document.getElementById('userRegionUSEast');
    const regionEUCentral = document.getElementById('userRegionEUCentral');
    if (!modal || !title || !emailInput || !allowedProficienciesInput) return;
    if (email) {
        title.textContent = 'Edit User';
        const user = userPermissions.find(u => u.Email === email);
        if (user) {
            emailInput.value = user.Email;
            emailInput.disabled = true;
            allowedProficienciesInput.value = user.AllowedProficiencies ? user.AllowedProficiencies.join('\n') : '';
            if (regionUSEast) regionUSEast.checked = (user.AllowedRegions || []).includes('us-east-1');
            if (regionEUCentral) regionEUCentral.checked = (user.AllowedRegions || []).includes('eu-central-1');
        }
    } else {
        title.textContent = 'Add User';
        emailInput.value = '';
        emailInput.disabled = false;
        allowedProficienciesInput.value = '';
        if (regionUSEast) regionUSEast.checked = false;
        if (regionEUCentral) regionEUCentral.checked = false;
    }
    modal.style.display = 'block';
}
function closeUserPermissionModal() {
    const modal = document.getElementById('userPermissionModal');
    if (modal) modal.style.display = 'none';
    editingUserEmail = null;
}
async function saveUserPermission() {
    const emailInput = document.getElementById('userEmailInput');
    const allowedProficienciesInput = document.getElementById('allowedProficienciesUserInput');
    const regionUSEast = document.getElementById('userRegionUSEast');
    const regionEUCentral = document.getElementById('userRegionEUCentral');
    if (!emailInput || !allowedProficienciesInput) return;
    const email = emailInput.value.trim();
    if (!email) {
        showError('Please enter an email address');
        return;
    }
    const proficienciesText = allowedProficienciesInput.value.trim();
    const allowedProficiencies = proficienciesText
        ? proficienciesText.split(/[\n,]+/).map(p => p.trim()).filter(p => p.length > 0)
        : [];
    const allowedRegions = [];
    if (regionUSEast && regionUSEast.checked) allowedRegions.push('us-east-1');
    if (regionEUCentral && regionEUCentral.checked) allowedRegions.push('eu-central-1');
    const userData = {
        Email: email,
        AllowedProficiencies: allowedProficiencies,
        AllowedRegions: allowedRegions
    };
    try {
        const method = editingUserEmail ? 'PUT' : 'POST';
        const url = editingUserEmail
            ? `${API_BASE_URL}/config/users/${encodeURIComponent(editingUserEmail)}?region=${selectedRegion}`
            : `${API_BASE_URL}/config/users?region=${selectedRegion}`;
        const response = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error ${response.status}`);
        }
        showSuccess(editingUserEmail ? 'User permission updated successfully' : 'User permission added successfully');
        closeUserPermissionModal();
        loadUserPermissions();
    } catch (error) {
        console.error('Error saving user permission:', error);
        showError(`Failed to save user permission: ${error.message}`);
    }
}
async function deleteUserPermission(email) {
    if (!confirm(`Are you sure you want to delete the permission for "${email}"?`)) return;
    try {
        const response = await fetch(`${API_BASE_URL}/config/users/${encodeURIComponent(email)}?region=${selectedRegion}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        showSuccess(`User "${email}" deleted successfully`);
        loadUserPermissions();
    } catch (error) {
        console.error('Error deleting user permission:', error);
        showError(`Failed to delete user: ${error.message}`);
    }
}
function editUserPermission(email) {
    openUserPermissionModal(email);
}
