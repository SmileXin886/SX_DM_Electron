/**
 * 即梦AI账号列表 - 纯 JS 拖拽排序引擎（突破 HTML5 限制 & 修复滤镜偏移）
 */
window.JimengDnD = {
    _containerId: null,
    _onReorder: null,
    _draggingItem: null,
    _placeholder: null,
    _offsetX: 0,
    _offsetY: 0,
    _initialized: false,

    _autoScrollFrame: null,
    _currentMouseY: 0,
    _scrollSpeed: 5,
    _edgeThreshold: 50,
    _isWheelScrolling: false,
    _wheelPauseTimer: null,

    init(containerId, onReorder) {
        this._containerId = containerId;
        this._onReorder = onReorder;

        if (this._initialized) return;
        this._initialized = true;

        const container = document.getElementById(containerId);
        if (!container) return;

        document.addEventListener('mousedown', this._onMouseDown.bind(this));
        document.addEventListener('mousemove', this._onMouseMove.bind(this), { passive: false });
        document.addEventListener('mouseup', this._onMouseUp.bind(this));

        container.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
    },

    reinit(containerId, onReorder) {
        this.init(containerId, onReorder);
    },

    _onMouseDown(e) {
        if (e.button !== 0) return;
        const handle = e.target.closest('.jm-drag-handle');
        if (!handle) return;

        const item = handle.closest('.jm-account-item');
        if (!item) return;

        e.preventDefault();

        document.querySelectorAll('.jm-placeholder').forEach(el => el.remove());

        this._draggingItem = item;
        const rect = item.getBoundingClientRect();

        this._offsetX = e.clientX - rect.left;
        this._offsetY = e.clientY - rect.top;

        this._placeholder = document.createElement('div');
        this._placeholder.className = 'jm-account-item jm-placeholder';
        this._placeholder.style.height = `${rect.height}px`;
        this._placeholder.style.background = 'transparent';
        this._placeholder.style.border = '1px dashed rgba(255, 255, 255, 0.2)';
        this._placeholder.style.borderRadius = '14px';
        this._placeholder.style.margin = '0';
        item.parentNode.insertBefore(this._placeholder, item);

        const scope = document.querySelector('.jm-scope') || document.body;
        scope.appendChild(item);

        item.classList.add('jm-dragging');
        item.style.position = 'fixed';
        item.style.left = `${e.clientX - this._offsetX}px`;
        item.style.top = `${e.clientY - this._offsetY}px`;
        item.style.width = `${rect.width}px`;
        item.style.pointerEvents = 'none';
        item.style.zIndex = '9999';

        this._currentMouseY = e.clientY;
        this._startAutoScroll();
    },

    _onMouseMove(e) {
        if (!this._draggingItem) return;

        e.preventDefault();
        this._currentMouseY = e.clientY;

        this._draggingItem.style.left = `${e.clientX - this._offsetX}px`;
        this._draggingItem.style.top = `${e.clientY - this._offsetY}px`;

        this._updatePlaceholderPosition();
    },

    _onMouseUp(e) {
        if (!this._draggingItem) return;

        this._stopAutoScroll();

        const container = document.getElementById(this._containerId);

        if (container && this._placeholder) {
            container.insertBefore(this._draggingItem, this._placeholder);
            this._placeholder.remove();
        }

        this._draggingItem.classList.remove('jm-dragging');
        this._draggingItem.style.position = '';
        this._draggingItem.style.top = '';
        this._draggingItem.style.left = '';
        this._draggingItem.style.width = '';
        this._draggingItem.style.pointerEvents = '';
        this._draggingItem.style.zIndex = '';

        this._draggingItem = null;
        this._placeholder = null;

        if (container) {
            const newOrderIds = [...container.querySelectorAll('.jm-account-item:not(.jm-placeholder)')]
                .map(item => item.dataset.accountId)
                .filter(Boolean);

            if (this._onReorder && newOrderIds.length > 0) {
                this._onReorder(newOrderIds);
            }
        }
    },

    _updatePlaceholderPosition() {
        const container = document.getElementById(this._containerId);
        if (!container || !this._placeholder) return;

        const siblings = [...container.querySelectorAll('.jm-account-item:not(.jm-dragging):not(.jm-placeholder)')];
        let closest = null;
        let minDist = Infinity;
        const mouseY = this._currentMouseY;

        for (const sibling of siblings) {
            const rect = sibling.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const dist = Math.abs(mouseY - centerY);
            if (dist < minDist) {
                minDist = dist;
                closest = sibling;
            }
        }

        if (closest) {
            const rect = closest.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            if (mouseY < centerY) {
                container.insertBefore(this._placeholder, closest);
            } else {
                container.insertBefore(this._placeholder, closest.nextSibling);
            }
        }
    },

    _startAutoScroll() {
        const container = document.getElementById(this._containerId);
        if (!container) return;

        const loop = () => {
            if (!this._draggingItem) {
                this._stopAutoScroll();
                return;
            }

            if (!this._isWheelScrolling) {
                const rect = container.getBoundingClientRect();
                let scrolled = false;

                if (this._currentMouseY <= rect.top + this._edgeThreshold) {
                    container.scrollTop -= this._scrollSpeed;
                    scrolled = true;
                }
                else if (this._currentMouseY >= rect.bottom - this._edgeThreshold) {
                    container.scrollTop += this._scrollSpeed;
                    scrolled = true;
                }

                if (scrolled) {
                    this._updatePlaceholderPosition();
                }
            }

            this._autoScrollFrame = requestAnimationFrame(loop);
        };

        this._autoScrollFrame = requestAnimationFrame(loop);
    },

    _stopAutoScroll() {
        if (this._autoScrollFrame) {
            cancelAnimationFrame(this._autoScrollFrame);
            this._autoScrollFrame = null;
        }
    },

    _onWheel(e) {
        if (!this._draggingItem) return;

        e.preventDefault();

        const container = document.getElementById(this._containerId);
        if (!container) return;

        container.scrollTop += e.deltaY * 0.5;
        this._updatePlaceholderPosition();

        this._isWheelScrolling = true;
        if (this._wheelPauseTimer) clearTimeout(this._wheelPauseTimer);
        this._wheelPauseTimer = setTimeout(() => {
            this._isWheelScrolling = false;
        }, 250);
    },

    reinit(containerId, onReorder) {
        this._initialized = false;
        this.init(containerId, onReorder);
    },
};
