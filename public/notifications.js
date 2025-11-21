// ============================================
// SISTEMA DE NOTIFICACIONES - notifications.js
// ============================================

class NotificationSystem {
    constructor() {
        this.permission = 'default';
        this.socket = null;
        this.soundEnabled = true;
        this.init();
    }

    // Inicializar sistema
    async init() {
        // Solicitar permisos
        await this.requestPermission();
        
        // Conectar Socket.IO
        this.connectSocket();
        
        // Cargar preferencias
        this.loadPreferences();
    }

    // Solicitar permiso para notificaciones
    async requestPermission() {
        if (!("Notification" in window)) {
            console.log("Este navegador no soporta notificaciones");
            return;
        }

        if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            this.permission = permission;
        } else {
            this.permission = Notification.permission;
        }

        return this.permission;
    }

    // Conectar Socket.IO
    connectSocket() {
        if (!window.io) {
            console.error('Socket.IO no está disponible');
            return;
        }

        this.socket = io();

        // Eventos generales
        this.socket.on('connect', () => {
            console.log('🔔 Sistema de notificaciones conectado');
            
            // Registrar usuario
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            if (user.id) {
                this.socket.emit('register', { 
                    userId: user.id, 
                    role: user.role 
                });
            }
        });

        this.socket.on('disconnect', () => {
            console.log('🔕 Sistema de notificaciones desconectado');
        });

        // Escuchar notificaciones
        this.socket.on('notification', (data) => {
            this.show(data);
        });
    }

    // Mostrar notificación
    show(data) {
        const {
            title = 'Delivery System',
            body = '',
            icon = '🔔',
            tag = 'default',
            url = null,
            sound = true,
            type = 'info' // info, success, warning, error
        } = data;

        // Notificación del navegador
        if (this.permission === 'granted') {
            const notification = new Notification(title, {
                body,
                icon: this.getIconUrl(icon),
                tag,
                badge: this.getIconUrl(icon),
                requireInteraction: type === 'error' || type === 'warning',
                silent: !this.soundEnabled
            });

            // Click en notificación
            notification.onclick = () => {
                window.focus();
                if (url) {
                    window.location.href = url;
                }
                notification.close();
            };

            // Auto-cerrar después de 5 segundos
            setTimeout(() => notification.close(), 5000);
        }

        // Notificación in-app (toast)
        this.showToast(data);

        // Sonido
        if (sound && this.soundEnabled) {
            this.playSound(type);
        }
    }

    // Toast notification (in-app)
    showToast(data) {
        const {
            title = 'Notificación',
            body = '',
            icon = '🔔',
            type = 'info',
            duration = 5000
        } = data;

        // Crear toast
        const toast = document.createElement('div');
        toast.className = `notification-toast notification-${type}`;
        toast.innerHTML = `
            <div class="notification-content">
                <div class="notification-icon">${icon}</div>
                <div class="notification-text">
                    <div class="notification-title">${title}</div>
                    <div class="notification-body">${body}</div>
                </div>
                <button class="notification-close" onclick="this.parentElement.parentElement.remove()">×</button>
            </div>
        `;

        // Agregar al DOM
        let container = document.getElementById('notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            document.body.appendChild(container);
        }

        container.appendChild(toast);

        // Auto-cerrar
        setTimeout(() => {
            toast.classList.add('notification-fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // Sonido de notificación
    playSound(type = 'info') {
        try {
            const audio = new Audio();
            
            // Frecuencias diferentes por tipo
            const frequencies = {
                info: [800, 1000],
                success: [800, 1200],
                warning: [600, 800],
                error: [400, 200]
            };

            const freq = frequencies[type] || frequencies.info;
            
            // Crear sonido con Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = freq[0];
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.2);
        } catch (error) {
            console.error('Error al reproducir sonido:', error);
        }
    }

    // Obtener URL de icono
    getIconUrl(icon) {
        // Para emojis, usar data URL
        if (icon.length <= 2) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = '48px Arial';
            ctx.fillText(icon, 8, 48);
            return canvas.toDataURL();
        }
        return icon;
    }

    // Guardar preferencias
    savePreferences() {
        localStorage.setItem('notification-sound', this.soundEnabled);
    }

    // Cargar preferencias
    loadPreferences() {
        const sound = localStorage.getItem('notification-sound');
        this.soundEnabled = sound === null ? true : sound === 'true';
    }

    // Toggle sonido
    toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        this.savePreferences();
        return this.soundEnabled;
    }

    // Métodos helper para tipos específicos
    success(title, body, options = {}) {
        this.show({
            title,
            body,
            icon: '✅',
            type: 'success',
            ...options
        });
    }

    error(title, body, options = {}) {
        this.show({
            title,
            body,
            icon: '❌',
            type: 'error',
            ...options
        });
    }

    warning(title, body, options = {}) {
        this.show({
            title,
            body,
            icon: '⚠️',
            type: 'warning',
            ...options
        });
    }

    info(title, body, options = {}) {
        this.show({
            title,
            body,
            icon: '💡',
            type: 'info',
            ...options
        });
    }

    // Notificaciones específicas del negocio
    newOrder(orderNumber, amount) {
        this.show({
            title: '🆕 Nuevo Pedido',
            body: `Pedido #${orderNumber} - $${amount}`,
            type: 'success',
            sound: true
        });
    }

    orderAccepted(orderNumber) {
        this.show({
            title: '✅ Pedido Aceptado',
            body: `Tu pedido #${orderNumber} fue aceptado por la tienda`,
            type: 'success'
        });
    }

    orderAssigned(orderNumber, driverName) {
        this.show({
            title: '🚗 Conductor Asignado',
            body: `${driverName} está en camino con tu pedido #${orderNumber}`,
            type: 'info'
        });
    }

    orderPickedUp(orderNumber) {
        this.show({
            title: '📦 Pedido Recogido',
            body: `Tu pedido #${orderNumber} está en camino`,
            type: 'info'
        });
    }

    orderDelivered(orderNumber) {
        this.show({
            title: '🎉 Pedido Entregado',
            body: `Tu pedido #${orderNumber} fue entregado. ¡Disfruta!`,
            type: 'success',
            sound: true
        });
    }

    orderCancelled(orderNumber) {
        this.show({
            title: '❌ Pedido Cancelado',
            body: `El pedido #${orderNumber} fue cancelado`,
            type: 'error'
        });
    }

    driverApproved() {
        this.show({
            title: '✅ Cuenta Aprobada',
            body: '¡Tu cuenta de conductor fue aprobada! Ya puedes empezar a trabajar.',
            type: 'success',
            sound: true
        });
    }

    driverRejected() {
        this.show({
            title: '❌ Cuenta Rechazada',
            body: 'Tu solicitud de conductor fue rechazada. Contacta al administrador.',
            type: 'error'
        });
    }

    newDriver(driverName) {
        this.show({
            title: '👤 Nuevo Conductor',
            body: `${driverName} está pendiente de aprobación`,
            type: 'info',
            url: '/admin'
        });
    }
}

// CSS para las notificaciones
const notificationStyles = `
<style id="notification-styles">
#notification-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    max-width: 400px;
}

.notification-toast {
    background: white;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    margin-bottom: 12px;
    animation: slideIn 0.3s ease-out;
    overflow: hidden;
}

.notification-toast.notification-success {
    border-left: 4px solid #10b981;
}

.notification-toast.notification-error {
    border-left: 4px solid #ef4444;
}

.notification-toast.notification-warning {
    border-left: 4px solid #f59e0b;
}

.notification-toast.notification-info {
    border-left: 4px solid #3b82f6;
}

.notification-content {
    display: flex;
    align-items: start;
    padding: 16px;
    gap: 12px;
}

.notification-icon {
    font-size: 24px;
    flex-shrink: 0;
}

.notification-text {
    flex: 1;
}

.notification-title {
    font-weight: 600;
    color: #1f2937;
    margin-bottom: 4px;
    font-size: 14px;
}

.notification-body {
    color: #6b7280;
    font-size: 13px;
    line-height: 1.4;
}

.notification-close {
    background: none;
    border: none;
    font-size: 24px;
    color: #9ca3af;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.2s;
}

.notification-close:hover {
    background: #f3f4f6;
    color: #4b5563;
}

.notification-fade-out {
    animation: fadeOut 0.3s ease-out forwards;
}

@keyframes slideIn {
    from {
        transform: translateX(400px);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}

@keyframes fadeOut {
    from {
        opacity: 1;
        transform: scale(1);
    }
    to {
        opacity: 0;
        transform: scale(0.9);
    }
}

@media (max-width: 640px) {
    #notification-container {
        top: 10px;
        right: 10px;
        left: 10px;
        max-width: none;
    }
}
</style>
`;

// Inyectar estilos
if (!document.getElementById('notification-styles')) {
    document.head.insertAdjacentHTML('beforeend', notificationStyles);
}

// Exportar instancia global
window.notifications = new NotificationSystem();