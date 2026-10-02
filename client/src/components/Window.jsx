export default function Window({ title, children, as: Tag = 'section', className = '', ...props }) {
  return (
    <Tag className={`window spot ${className}`} {...props}>
      <div className="window-bar">
        <span className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="window-title">{title}</span>
      </div>
      <div className="window-body">{children}</div>
    </Tag>
  );
}
