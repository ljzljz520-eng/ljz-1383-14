document.addEventListener('DOMContentLoaded', () => {
    // Header background on scroll
    const header = document.querySelector('header');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            header.classList.add('scrolled', 'glass');
        } else {
            header.classList.remove('scrolled', 'glass');
        }
    });

    // Toast Notification System
    const toastContainer = document.getElementById('toast-container');

    window.showToast = (message, type = 'success') => {
        const toast = document.createElement('div');
        toast.className = `toast ${type} glass`;
        toast.innerHTML = `
            <span>${type === 'success' ? '✓' : '✕'}</span>
            <span>${message}</span>
        `;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };

    // Form Validation Logic
    const contactForm = document.getElementById('contact-form');
    if (contactForm) {
        contactForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const message = document.getElementById('message').value.trim();
            
            if (!name) {
                showToast('请输入您的姓名', 'error');
                return;
            }
            
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!email || !emailRegex.test(email)) {
                showToast('请输入有效的邮箱地址', 'error');
                return;
            }
            
            if (!message) {
                showToast('请输入留言内容', 'error');
                return;
            }

            showToast('发送成功！我会尽快给您回复。', 'success');
            contactForm.reset();
        });
    }

    // Portfolio Filtering logic
    const tabs = document.querySelectorAll('.tab');
    const projects = document.querySelectorAll('.work-card');

    if (tabs.length > 0 && projects.length > 0) {
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const filter = tab.getAttribute('data-filter');

                // Update active tab
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Filter projects
                projects.forEach(project => {
                    const category = project.getAttribute('data-category');
                    const shouldShow = (filter === 'all' || filter === category);
                    const currentlyVisible = project.style.display !== 'none';

                    if (shouldShow) {
                        if (!currentlyVisible) {
                            project.style.display = 'block';
                            // Small delay to trigger transition
                            requestAnimationFrame(() => {
                                project.style.opacity = '1';
                                project.style.transform = 'scale(1)';
                            });
                        } else {
                            // Already visible, ensure states are set without triggering new transitions
                            project.style.opacity = '1';
                            project.style.transform = 'scale(1)';
                        }
                    } else {
                        if (currentlyVisible) {
                            project.style.opacity = '0';
                            project.style.transform = 'scale(0.95)';
                            setTimeout(() => {
                                if (project.style.opacity === '0') {
                                    project.style.display = 'none';
                                }
                            }, 300);
                        }
                    }
                });
            });
        });
    }
});
